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

    for (const tf of ['1min', 'day']) {
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
const _noFmpUntil   = new Map()   // symbol → ts to retry FMP after
const NO_FMP_TTL_MS = 10 * 60_000

/**
 * Best price for MARKING open-position P&L AND for touch-fill detection. Prefers a
 * real-time last quote (FMP `/quote` — equities / ETFs / crypto / forex, on the fast
 * ~3s cache), falling back to the latest INTRADAY (1-min) candle close for anything FMP
 * can't price. It deliberately does NOT fall back to a *day* candle: a coarse, stale day
 * close would false-trigger a touch fill — a TP/stop firing against a level the live price
 * never reached (see project_timestamp_ideas Issue 1). No live-enough price → null, and
 * both callers degrade safely (the mark loop keeps the last mark; the fill loop doesn't
 * trigger that tick).
 */
export async function latestMarkPrice(symbol) {
    const retryAfter = _noFmpUntil.get(symbol)
    if (retryAfter == null || Date.now() > retryAfter) {
        try {
            const price = await getFmpQuote(symbol)
            if (price != null && Number.isFinite(price) && price > 0) {
                _noFmpUntil.delete(symbol)
                return price
            }
        } catch { /* provider error — fall back to an intraday candle */ }
        _noFmpUntil.set(symbol, Date.now() + NO_FMP_TTL_MS)
    }
    // Intraday (1-min) candle close ONLY — never a day candle (see above).
    try {
        const candles = await getCandles(symbol, '1min', 1)
        const c = candles?.at(-1)?.c
        return c != null && Number.isFinite(c) ? c : null
    } catch {
        return null
    }
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

export const paperExecutionService = { openPosition, reducePosition, computeEquity, latestPrice, latestMarkPrice, quoteMapForSymbols, applySpread, dirSign, round2 }
