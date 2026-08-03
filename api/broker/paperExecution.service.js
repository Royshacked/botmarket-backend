/**
 * Paper execution primitives.
 *
 * The two position-mutation operations shared by the paper adapter (market fills /
 * manual closes) and the paper fill engine (working-order triggers), so there is one
 * code path that mutates virtual positions, banks P&L, and emits the normalized
 * execution events the reconciler consumes.
 *
 * Cash moves only by realized P&L (Phase 3 adds spread/commission), so equity stays
 * cashBalance + Σ unrealized with no notional bookkeeping.
 */

import { randomUUID }        from 'crypto'
import { paperBrokerService } from './paperBroker.service.js'
import { getCandles }         from '../../providers/ohlcv.provider.js'
import { getFmpQuote }        from '../../providers/fmp.price.provider.js'
import { executionBus }       from '../../services/executionBus.js'
import { isAssetOpen }        from '../../services/market.service.js'
import { createTtlCache }     from '../../services/ttlCache.util.js'
import { logger }             from '../../services/logger.service.js'

const LOG = '[paperExecution]'

/** long → +1, short → −1 (P&L sign). */
export const dirSign = dir => (dir === 'short' ? -1 : 1)
export const round2  = n => Math.round(n * 100) / 100
const round8 = n => Math.round(n * 1e8) / 1e8

/**
 * Cross the spread: a BUY fills at the ask (mid + half-spread), a SELL at the bid
 * (mid − half-spread). `spreadBps` is basis points of price; the caller passes the
 * mid (or trigger) price and gets the effective fill. Spread cost is thus baked into
 * the position's entry/exit price; commission is accounted separately as cash.
 */
export function applySpread(price, isBuy, spreadBps = 0) {
    if (!spreadBps) return price
    const half = price * (spreadBps / 10_000) / 2
    return isBuy ? price + half : price - half
}

// Last-known quote per symbol, shared by P&L marking and the fill engine. Both the
// client mark poll (~4s, ×each symbol ×[positions + equity]) and the fill loop
// (~5s, PAPER_FILL_INTERVAL_MS) need "latest price per symbol", and the OHLCV provider
// is rate-limited (429s) — so an uncached fetch-per-call exhausts the quota and blanks
// the price → P&L shows "—" and simulated stop/TP levels stop being checked. This cache
// collapses the overlapping callers to ~one real fetch per symbol per TTL, and on a
// failed/empty fetch reuses the last good quote instead of returning null. Keep the TTL
// in the "every few seconds" range so touch-based stop/TP fills stay responsive — the
// fill loop can only be as fresh as the quote it reads.
//
// DELIBERATELY NOT services/ttlCache.util.js: this is a stale-while-error cache, not a
// plain TTL cache. The fallback below reads the entry AFTER it has expired, and
// createTtlCache.get() evicts on expiry — routing this through it would silently drop
// the last-known quote and blank P&L on any transient provider error.
const _quoteCache   = new Map()   // symbol → { quote, at }
const QUOTE_TTL_MS  = Number(process.env.PAPER_QUOTE_TTL_MS) || 5_000

/**
 * Latest live quote for a symbol from the most recent 1-min candle (day fallback):
 * `{ c, h, l }` — close for marking P&L, high/low for intrabar touch triggers. h/l fall
 * back to c for degenerate feeds. Returns the last-known quote when a fresh fetch fails,
 * and null only when the symbol has never resolved.
 */
export async function latestQuote(symbol) {
    const cached = _quoteCache.get(symbol)
    if (cached && Date.now() - cached.at < QUOTE_TTL_MS) return cached.quote

    // Skip the intraday (1-min) fetch when the asset's session is closed: there are no fresh
    // 1-min bars (market closed / weekend), so it just returns empty and logs provider noise.
    // The day candle still marks the position against its last close. Crypto is 24h → keeps 1-min.
    const timeframes = isAssetOpen(symbol) ? ['1min', 'day'] : ['day']
    for (const tf of timeframes) {
        try {
            const candles = await getCandles(symbol, tf, 1)
            const last    = candles?.at(-1)
            if (last?.c != null) {
                const quote = { c: last.c, h: last.h ?? last.c, l: last.l ?? last.c }
                _quoteCache.set(symbol, { quote, at: Date.now() })
                return quote
            }
        } catch (err) {
            logger.warn(LOG, `latestQuote ${symbol}/${tf} failed: ${err.message}`)
        }
    }
    // Fresh fetch failed / no candles — reuse the last good quote so marking doesn't
    // blank out on a transient provider error. Only truly-never-seen symbols return null.
    if (cached) {
        logger.warn(LOG, `latestQuote ${symbol}: fresh fetch failed, reusing last-known quote`)
        return cached.quote
    }
    return null
}

/** Latest live price for a symbol (most recent candle close), or null. */
export async function latestPrice(symbol) {
    return (await latestQuote(symbol))?.c ?? null
}

/** Map of symbol → latest mark price for the distinct symbols given (one fetch per symbol).
 *  Shared by the fill engine, the mark loop, and equity mark-to-market. */
export async function quoteMapForSymbols(symbols) {
    const distinct = [...new Set(symbols)]
    const entries  = await Promise.all(distinct.map(async s => [s, await latestMarkPrice(s)]))
    return new Map(entries)
}

// Symbols FMP can't price (some futures / index CFDs / broker symbols) — cached with a
// retry TTL so we don't re-hit FMP every mark tick for a symbol it can't resolve, but a
// transient miss on a real equity re-tries later instead of downgrading forever.
// A fresh entry means "FMP can't price this — skip it"; the entry expiring IS the retry.
const NO_FMP_TTL_MS = 10 * 60_000
const _noFmp        = createTtlCache({ ttlMs: NO_FMP_TTL_MS, max: 500 })   // symbol → true

/**
 * Best price for MARKING open-position P&L AND for touch-fill detection. Prefers a
 * real-time last quote (FMP `/quote` — equities / ETFs / crypto / forex, on the fast
 * ~3s cache), falling back to the latest INTRADAY (1-min) candle close for anything FMP
 * can't price. It deliberately does NOT fall back to a *day* candle: a coarse, stale day
 * close would false-trigger a touch fill — a TP/stop firing against a level the live price
 * never reached (see project_timestamp_ideas Issue 1). No live-enough price → null, and
 * both callers degrade safely (the mark loop keeps the last mark; the fill loop doesn't
 * trigger that tick).
 *
 * Note how thin the ladder actually is: on an FMP plan WITHOUT intraday candles the second
 * rung is empty for equities, so `/quote` is the only real-time price this venue has. That
 * is why the suppression cache below must never be set on a transient error.
 *
 * @param {string} symbol
 * @param {{ quote?: Function, candles?: Function, isOpen?: Function }} [deps]  injectable for tests
 */
export async function latestMarkPrice(symbol, deps = {}) {
    const { quote = getFmpQuote, candles: fetchCandles = getCandles, isOpen = isAssetOpen } = deps
    // get() returns undefined when absent OR expired (it evicts on read), so a falsy
    // hit is exactly "no live suppression — try FMP".
    if (!_noFmp.get(symbol)) {
        try {
            const price = await quote(symbol)
            if (price != null && Number.isFinite(price) && price > 0) return price
            // FMP ANSWERED and had no price — that is a coverage fact about the symbol
            // (a future, an index CFD, a broker alias), so it is worth remembering.
            _noFmp.set(symbol, true)
        } catch {
            // A THROWN error is the provider having a bad moment — a 429, a timeout, a blip.
            // It says nothing about whether FMP covers this symbol, and recording it here
            // used to suppress the only working price source for a full 10 minutes: a
            // one-second rate limit became a ten-minute outage in which every entry on the
            // symbol was refused and every open position stopped marking. Ask again next tick.
        }
    }
    // Intraday (1-min) candle close ONLY — never a day candle (see above). Skip entirely when
    // the session is closed: no fresh intraday bars exist, so the fetch only returns empty and
    // logs noise, and the caller degrades safely on null (the fill loop simply doesn't trigger).
    if (!isOpen(symbol)) return null
    try {
        const candles = await fetchCandles(symbol, '1min', 1)
        const c = candles?.at(-1)?.c
        return c != null && Number.isFinite(c) ? c : null
    } catch {
        return null
    }
}

const usable = p => p != null && Number.isFinite(p) && p > 0

/**
 * Price to BOOK AN EXIT at — a close/trim that has already been decided (the user pressed ✕, a
 * monitor's exit condition fired, a rebalance is trimming a leg).
 *
 * This is deliberately NOT latestMarkPrice. That one refuses to fall back to a day candle because
 * it also answers "did the price TOUCH this level" — a coarse, stale close there would fire a TP
 * against a level the live price never reached. An exit isn't a trigger: the decision is made, and
 * all that's left is a number to book it at. Applying the touch rule here meant an outage in the
 * 1-min feed (FMP 429s, a provider gap) turned into a position the user could not close AT ALL —
 * a 500 on a market order, with a perfectly good day close sitting one call away.
 *
 * So it degrades instead of refusing, worst case to the mark the UI has been showing all along:
 *   live → the same real-time quote everything else marks against
 *   day  → today's close-so-far (during a session this tracks the last print)
 *   mark → the last price stamped on the position by the mark loop
 * `source` comes back so the caller can say which one it used — a fill booked off a stale price
 * should not look identical to one booked off the live quote.
 *
 * @param {string} symbol
 * @param {number|null} [stamped]  position.currentPrice — the last mark stamped on the doc
 * @param {{live?: Function, last?: Function}} [deps]  injectable for tests
 * @returns {Promise<{ price: number|null, source: 'live'|'day'|'mark'|null }>}
 */
export async function exitMarkPrice(symbol, stamped = null, deps = {}) {
    const { live = latestMarkPrice, last = latestPrice } = deps

    const mark = await live(symbol)
    if (usable(mark)) return { price: mark, source: 'live' }

    // Day-candle close (latestQuote's own fallback), which is exactly what latestMarkPrice
    // withholds — and the only price available when the intraday feed is down.
    const dayClose = await last(symbol)
    if (usable(dayClose)) return { price: dayClose, source: 'day' }

    if (usable(stamped)) return { price: stamped, source: 'mark' }
    return { price: null, source: null }
}

// A beat, not a backoff. Long enough that a rate-limited window has moved on, short enough to
// be invisible inside an order round-trip the user is already waiting on.
const ENTRY_RETRY_DELAY_MS = 300

/**
 * Price to FILL AN ENTRY at — the counterpart of exitMarkPrice, and deliberately NOT its twin.
 *
 * An exit degrades: the decision is already made, and refusing to book it strands a position
 * nobody can get out of. An entry is the opposite trade-off. Its price becomes the position's
 * cost basis for life — every P&L number, every R multiple, every line of the ledger is measured
 * from it — and a simulated venue whose entries are booked off stale prints is not simulating
 * anything. Refusing to open is recoverable in a way a wrong basis is not. So this NEVER falls
 * back to a coarser price.
 *
 * What it does instead is ask twice. The single real-time source can blink — an FMP 429, a
 * timeout — and the first ask may also be answered by a 3s-cached miss from a poll that blinked
 * a moment earlier. One fresh retry, past that cache, is the difference between "the market has
 * no price" and "we happened to ask at a bad instant"; only the first is worth refusing over.
 *
 * @param {string} symbol
 * @param {{ mark?: Function, fresh?: Function, wait?: Function, delayMs?: number }} [deps]  injectable for tests
 * @returns {Promise<{ price: number|null, source: 'live'|'retry'|null }>}
 */
export async function entryMarkPrice(symbol, deps = {}) {
    const {
        mark    = latestMarkPrice,
        fresh   = (s) => latestMarkPrice(s, { quote: (sym) => getFmpQuote(sym, { fresh: true }) }),
        wait    = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
        delayMs = ENTRY_RETRY_DELAY_MS,
    } = deps

    const live = await mark(symbol)
    if (usable(live)) return { price: live, source: 'live' }

    await wait(delayMs)
    const again = await fresh(symbol)
    if (usable(again)) return { price: again, source: 'retry' }

    return { price: null, source: null }
}

/**
 * Open a new virtual position and emit position.opened. `orderId` must be the id of
 * the order that opened it (the market order, or the resting-entry working order) —
 * the reconciler matches a resting-entry fill on accountId + orderId.
 *
 * The emit is deferred (setImmediate) so it lands AFTER any synchronous caller
 * (placeOrdersForIdea) finishes stamping the idea — mirroring a real broker's async
 * socket push.
 * @returns {Promise<string>} the new positionId
 */
export async function openPosition({ userId, accountId, symbol, direction, qty, price, orderId }) {
    const acct = await paperBrokerService.getAccount(userId, accountId)
    // Fail loud rather than stamp a position with a dead accountId (which computeEquity
    // can't roll up and whose close would silently drop realized P&L). The old
    // getOrCreateAccount masked this by auto-creating; accounts are now explicit.
    if (!acct) throw new Error(`paper openPosition: account ${accountId} not found`)
    const { spreadBps = 0, commissionPerTrade = 0 } = acct.settings ?? {}
    const fillPrice = applySpread(price, direction === 'long', spreadBps)

    const positionId = randomUUID()
    await paperBrokerService.insertPosition({
        userId, accountId, positionId,
        symbol, direction, qty,
        avgPrice:        fillPrice,   // effective entry — entry spread baked in
        entryCommission: commissionPerTrade,
        openedAt:        Date.now(),
        status:          'open',
    })

    // Entry commission is a realized cost (spread is already captured via avgPrice).
    if (commissionPerTrade) {
        await paperBrokerService.adjustBalance(userId, accountId, { cash: -commissionPerTrade, realizedPnl: -commissionPerTrade })
    }

    setImmediate(() => executionBus.emit('execution', {
        broker:    'paper',
        simulated: true,   // idealess fills are still captured to trade history (reconciler flag)
        type:      'position.opened',
        userId,
        accountId,
        orderId,
        positionId,
        symbol,
        direction,
        quantity:  qty,
        price:     fillPrice,
        commission: commissionPerTrade,                          // entry commission (cash cost)
        spread:     round2(Math.abs(fillPrice - price) * qty),   // entry spread cost (baked into fillPrice)
        at:        Date.now(),
    }))
    logger.info(LOG, `Opened position ${positionId}: ${direction} ${qty} ${symbol} @ ${fillPrice} (mid ${price}, comm ${commissionPerTrade})`)
    return positionId
}

/**
 * Reduce a position by `qty` at `price`, bank realized P&L, and emit the matching
 * execution event. A full reduction closes the position (and cancels its resting
 * closing orders); a partial keeps it open and emits position.reduced.
 *
 * `orderId` (when the reduction came from a tracked closing order) is carried on the
 * event so the reconciler can match the exit slice and attribute the leg.
 */
export async function reducePosition({ userId, positionId, qty, price, reason = 'manual', orderId = null }) {
    const pos = await paperBrokerService.getPosition(userId, positionId)
    if (!pos || pos.status !== 'open') return
    const acct = await paperBrokerService.getAccount(userId, pos.accountId)
    // Defensive: deleteAccount guards against removing an account with open positions,
    // so this is unreachable — but if it ever happens, skip loudly instead of banking
    // P&L into a no-op adjustBalance (which would silently vanish the realized amount).
    if (!acct) {
        logger.error(LOG, `reducePosition: account ${pos.accountId} missing for open position ${positionId} — skipping to avoid dropping P&L`)
        return
    }
    const { spreadBps = 0, commissionPerTrade = 0 } = acct.settings ?? {}

    const closeQty  = Math.min(qty, pos.qty)
    // Closing trade side is the opposite of the position: close a long by SELLing (bid),
    // close a short by BUYing (ask). Spread + commission make the P&L honest.
    const exitPrice   = applySpread(price, pos.direction === 'short', spreadBps)
    const spreadCost  = round2(Math.abs(exitPrice - price) * closeQty)   // exit spread cost (in exitPrice)
    const gross       = (exitPrice - pos.avgPrice) * closeQty * dirSign(pos.direction)
    const net         = gross - commissionPerTrade
    await paperBrokerService.adjustBalance(userId, pos.accountId, { cash: net, realizedPnl: net })

    const remaining = round8(pos.qty - closeQty)
    if (remaining > 0) {
        await paperBrokerService.updatePosition(userId, positionId, { qty: remaining })
        executionBus.emit('execution', {
            broker: 'paper', simulated: true, type: 'position.reduced', userId, accountId: pos.accountId,
            positionId, ...(orderId != null && { orderId }),
            symbol: pos.symbol, direction: pos.direction,
            quantity: closeQty, price: exitPrice, pnl: round2(net),
            commission: commissionPerTrade, spread: spreadCost, reason, at: Date.now(),
        })
        logger.info(LOG, `Reduced position ${positionId} by ${closeQty} @ ${exitPrice} (net ${round2(net)}), ${remaining} left`)
        return
    }

    await paperBrokerService.updatePosition(userId, positionId, {
        status: 'closed', closedAt: Date.now(), exitPrice, realizedPnl: round2(net),
    })
    await _cancelClosingOrders(userId, positionId, orderId)
    executionBus.emit('execution', {
        broker: 'paper', simulated: true, type: 'position.closed', userId, accountId: pos.accountId,
        positionId, ...(orderId != null && { orderId }),
        symbol: pos.symbol, direction: pos.direction,
        price: exitPrice, pnl: round2(net),
        commission: commissionPerTrade, spread: spreadCost, reason, at: Date.now(),
    })
    logger.info(LOG, `Closed position ${positionId} @ ${exitPrice} (net ${round2(net)})`)
}

/**
 * Mark-to-market ONE account: cash + Σ unrealized (its open positions valued at the
 * live price). The single source of truth for equity, used by getAccount and the equity-
 * curve snapshotter. Identity: equity = startingBalance + realizedPnl + unrealized.
 * Returns a zeroed reading when the account is missing (deleted mid-flight).
 *
 * Also reports EXPOSURE: marginUsed = Σ notional (qty × avgPrice, computed live so a
 * partial reduce shrinks it) and, when a buying-power cap is set (settings.maxLeverage),
 * buyingPower = equity × maxLeverage plus an overLeveraged flag. maxLeverage 0 = off →
 * buyingPower null (advisory-only, never blocks a fill).
 * @param {string} userId
 * @param {string} accountId
 * @returns {Promise<{currency,cashBalance,realizedPnl,unrealized,equity,openPositions,marginUsed,buyingPower,overLeveraged}>}
 */
/**
 * Capital already COMMITTED to open positions, per account — cost basis at entry, the same
 * `|avgPrice × qty|` computeEquity calls `marginUsed`.
 *
 * Exists because a virtual account's cash does NOT move when a position opens: `adjustBalance` is
 * called with the commission on open and the realized amount on CLOSE, so `cashBalance` is
 * starting-balance + realized P&L and still counts every dollar sitting in an open holding. An agent
 * sizing a new book against it allocates money that is already invested — which is exactly what a
 * user with open equities saw.
 *
 * One query for every account, and deliberately NO quote fetch: cost basis needs entry price only.
 * That is what makes this affordable on an accounts LIST, which is called far more often than the
 * single-account read.
 */
export async function committedByAccount(userId) {
    const positions = await paperBrokerService.listPositions(userId, { status: 'open' })
    const by = new Map()
    for (const p of positions) {
        const key = String(p.accountId)
        by.set(key, (by.get(key) ?? 0) + Math.abs(p.avgPrice * p.qty))
    }
    return by
}

/** Deployable cash: leveraged buying power where leverage is on, otherwise cash not yet committed. */
export function deployable({ cashBalance = 0, marginUsed = 0, buyingPower = null } = {}) {
    return round2(Math.max(0, (buyingPower != null ? buyingPower : cashBalance) - marginUsed))
}

export async function computeEquity(userId, accountId) {
    const acct = await paperBrokerService.getAccount(userId, accountId)
    if (!acct) return {
        currency: 'USD', cashBalance: 0, realizedPnl: 0, unrealized: 0, equity: 0,
        openPositions: 0, marginUsed: 0, buyingPower: null, overLeveraged: false,
    }
    const positions = await paperBrokerService.listPositions(userId, { status: 'open', accountId })

    let unrealized = 0
    let marginUsed = 0
    if (positions.length) {
        const priceBy = await quoteMapForSymbols(positions.map(p => p.symbol))
        for (const p of positions) {
            marginUsed += Math.abs(p.avgPrice * p.qty)   // exposure at entry price (live qty)
            // Fall back to the last stored mark so equity doesn't jump when a quote misses.
            const px = priceBy.get(p.symbol) ?? p.currentPrice
            if (px == null) continue
            unrealized += (px - p.avgPrice) * p.qty * dirSign(p.direction)
        }
    }
    const equity      = round2(acct.cashBalance + unrealized)
    const maxLeverage = Number(acct.settings?.maxLeverage) || 0
    const buyingPower = maxLeverage > 0 ? round2(equity * maxLeverage) : null
    return {
        currency:      acct.currency,
        cashBalance:   round2(acct.cashBalance),
        realizedPnl:   round2(acct.realizedPnl),
        unrealized:    round2(unrealized),
        equity,
        openPositions: positions.length,
        marginUsed:    round2(marginUsed),
        buyingPower,
        overLeveraged: buyingPower != null && round2(marginUsed) > buyingPower,
    }
}

/** Cancel all working orders that close the given position (except the one that filled). */
async function _cancelClosingOrders(userId, positionId, exceptOrderId = null) {
    const working = await paperBrokerService.listOrders(userId, { status: 'working' })
    for (const o of working) {
        if (String(o.positionId) === String(positionId) && String(o.orderId) !== String(exceptOrderId)) {
            await paperBrokerService.updateOrder(userId, o.orderId, { status: 'cancelled', cancelledAt: Date.now() })
        }
    }
}

export const paperExecutionService = { openPosition, reducePosition, computeEquity, latestPrice, latestMarkPrice, exitMarkPrice, entryMarkPrice, quoteMapForSymbols, applySpread, dirSign, round2 }
