/**
 * cTrader broker adapter.
 * Implements BrokerAdapter using the cTrader Open API (Spotware).
 *
 * Two transports are used, each for what only it can do:
 *   • REST (ctrader.provider.js)     — OAuth + account/position summaries.
 *   • ProtoOA WebSocket (session)    — trading: place / protect / close orders,
 *                                      and OHLCV-grade symbol specs.
 *
 * Note on candles: cTrader's OHLCV data lives on the ProtoOA WebSocket
 * protocol, NOT on the REST API. getCandles() fetches trendbars over the
 * session socket so the monitor can evaluate a cTrader idea in the broker's
 * own price space (capabilities().ohlcv = true); an unsupported timeframe or
 * any failure returns null, so the caller falls back to Massive/Yahoo.
 */

import { BrokerAdapter }           from './broker.interface.js'
import { asList, num, money }      from './normalize.js'
import * as ctrader                from '../../../providers/ctrader.provider.js'
import { brokerConnectionService } from '../brokerConnection.service.js'
import { logger }                  from '../../../services/logger.service.js'
import { parseTimeframe }          from '../../../services/timeframe.service.js'
import { executionBus }            from '../../../services/executionBus.js'
import { toExecution, TRADE_SIDE, PROTO_ORDER_TYPE } from './ctrader.execution.js'
import {
    listCTraderAccounts,
    matchCTraderAccount,
    getCTraderSession,
    normalizeVolume,
    lotsToVolume,
    roundPrice,
    priceToRelative,
} from '../../../providers/ctrader.session.provider.js'

const LOG = '[ctrader.adapter]'

// ProtoOA enums (sent as integers in JSON).
// TRADE_SIDE / PROTO_ORDER_TYPE (and the inbound execution enums) live in
// ctrader.execution.js alongside the translator; imported back where still used.
const ORDER_TYPE   = { market: 1, limit: 2, stop: 3 }
const PT = {
    NEW_ORDER:      2106,   // ProtoOANewOrderReq
    // NOTE: 2107 is ProtoOATrailingSLChangedEvent — CancelOrder/AmendOrder are 2108/2109.
    CANCEL_ORDER:   2108,   // ProtoOACancelOrderReq (working order, by orderId)
    AMEND_ORDER:    2109,   // ProtoOAAmendOrderReq (working order limit/stop price)
    AMEND_SLTP:     2110,   // ProtoOAAmendPositionSLTPReq (absolute prices)
    CLOSE_POSITION: 2111,   // ProtoOAClosePositionReq (requires volume)
    RECONCILE:      2124,   // ProtoOAReconcileReq → open positions/orders
}

// Module-level so the idempotency guard survives the factory minting a fresh
// adapter per call — the listener lives on the cached (singleton) session.
const _wiredFeeds = new Set()  // `${env}:${ctid}`

// App timeframe (via parseTimeframe → {timeSpan, multiplier}) → ProtoOATrendbarPeriod
// enum. Only cTrader-supported bar widths are listed; any other timeframe (e.g. 2hr,
// 3min) has no cTrader period and yields null → the caller falls back to the app feed.
const TRENDBAR_PERIOD = {
    'minute:1': 1,  'minute:2': 2,  'minute:3': 3,  'minute:4': 4,
    'minute:5': 5,  'minute:10': 6, 'minute:15': 7, 'minute:30': 8,
    'hour:1':   9,  'hour:4':  10,  'hour:12': 11,
    'day:1':   12,  'week:1':  13,  'month:1': 14,
}

/**
 * Map an app timeframe string ("5min"/"1hr"/"day") to a ProtoOATrendbarPeriod enum,
 * or null when cTrader has no matching bar width. Exported for unit testing.
 * @param {string} timeframe
 * @returns {number|null}
 */
export function toTrendbarPeriod(timeframe) {
    const opts = parseTimeframe(timeframe)
    if (!opts) return null
    const m = Math.max(1, Math.trunc(Number(opts.multiplier) || 1))
    return TRENDBAR_PERIOD[`${opts.timeSpan}:${m}`] ?? null
}

export class CTraderAdapter extends BrokerAdapter {

    brokerType  = 'ctrader'
    brokerLabel = 'cTrader'
    provider    = ctrader

    // ── OAuth ──────────────────────────────────────────────────────────────────

    getAuthUrl(state) {
        return ctrader.getAuthUrl(state)
    }

    async handleCallback(code, userId) {
        const tokens = await ctrader.exchangeCode(code)
        await brokerConnectionService.saveConnection(userId, 'ctrader', tokens)
        logger.info(LOG, `Connection saved for user ${userId}`)
    }

    // ── Status ─────────────────────────────────────────────────────────────────

    async isConnected(userId) {
        const conn = await brokerConnectionService.getConnection(userId, 'ctrader')
        return !!conn?.refreshToken
    }

    // ── Account ────────────────────────────────────────────────────────────────

    async getAccount(userId) {
        const tokens    = await this._freshTokens(userId)
        const accountId = await this._resolveAccountId(userId, tokens)
        const raw  = await ctrader.get('/tradingaccounts', tokens)
        const list = asList(raw)
        const account = list.find(a => String(a.id ?? a.accountId) === String(accountId))
        if (!account) throw new Error(`cTrader account ${accountId} not found in accounts list`)
        return _normaliseAccount(account)
    }

    // ── Positions ──────────────────────────────────────────────────────────────

    async getPositions(userId) {
        // Positions can live across several trading accounts on the same connection
        // (one idea may be placed on multiple accounts of the same broker), so we
        // reconcile EVERY account's session — not just the selected one — and tag each
        // position with the account it lives on. That lets the UI list them all and a
        // close route back to the right account.
        // cTrader exposes open positions only on the ProtoOA WebSocket (not REST).
        try {
            const accounts = await this.getTradingAccounts(userId)
            const lists = await Promise.all(accounts.map(async acct => {
                try {
                    const session = await this._session(userId, acct.id)
                    const rows    = await session.getOpenPositions()
                    return rows.map(p => ({
                        ...p,
                        accountId: acct.id,
                        accountNo: acct.login ?? null,
                        currency:  acct.currency ?? null,
                    }))
                } catch (err) {
                    logger.warn(LOG, `getPositions account ${acct.id}: ${err.message}`)
                    return []
                }
            }))
            return lists.flat()
        } catch (err) {
            logger.warn(LOG, `getPositions (ctrader): ${err.message}`)
            return []
        }
    }

    /**
     * Authoritative single-position lookup on the account the position lives on.
     * Returns the open position (getOpenPositions shape) or `null` when it no longer
     * exists. THROWS on a transport/session error so the caller can tell "gone" (null)
     * apart from "couldn't reach the broker" (throw) — the reconciler relies on that
     * distinction to never close an idea on a transient failure.
     * @returns {Promise<object|null>}
     */
    async findOpenPosition(userId, accountId, positionId) {
        const session   = await this._session(userId, accountId)
        const positions = await session.getOpenPositions()
        return positions.find(p => String(p.id) === String(positionId)) ?? null
    }

    // ── Trading accounts ───────────────────────────────────────────────────────

    async getTradingAccounts(userId) {
        const tokens = await this._freshTokens(userId)
        const raw    = await ctrader.get('/tradingaccounts', tokens)
        const list   = asList(raw)
        return list.map(_normaliseTradingAccount)
    }

    // ── Candles — OHLCV via ProtoOA trendbars ──────────────────────────────────

    /**
     * OHLCV bars over the ProtoOA socket (cTrader has no REST candles). The monitor
     * prefers this (capabilities().ohlcv) so a cTrader idea is evaluated in the
     * broker's own price space. Any user account can fetch symbol data, so we resolve
     * the user's default trading account for the session. Unsupported timeframe or any
     * failure → null, so the caller falls back to the app feed (Massive/Yahoo).
     * @param {string} symbol     broker symbol, e.g. 'US100.cash'
     * @param {string} timeframe  app timeframe, e.g. '5min' | '1hr' | 'day'
     * @param {number} count
     * @param {string} userId
     * @returns {Promise<Array<{t,o,h,l,c,v}>|null>}
     */
    async getCandles(symbol, timeframe, count = 300, userId) {
        if (!symbol || !userId) return null
        const period = toTrendbarPeriod(timeframe)
        if (period == null) return null

        try {
            const tokens    = await this._freshTokens(userId)
            const accountId = await this._resolveAccountId(userId, tokens)
            const session   = await this._session(userId, accountId)
            const bars      = await session.getTrendbars(symbol, period, count)
            return bars.length ? bars : null
        } catch (err) {
            logger.warn(LOG, `getCandles ${symbol}/${timeframe}: ${err.message}`)
            return null
        }
    }

    /**
     * Resolve an app symbol to cTrader's tradable name via the account's symbol list
     * ("getTicker"), e.g. 'NQ'/'US100' → 'US100.cash'. Returns found:false when the
     * instrument isn't listed on the account; RE-THROWS transport/session errors so the
     * caller can tell "not listed" from "unreachable" (see interface contract).
     */
    async resolveSymbol(userId, accountId, symbol) {
        const session = await this._session(userId, accountId)
        try {
            const specs = await session.resolveSymbol(symbol)
            return { symbol: specs.symbolName ?? symbol, found: true }
        } catch (err) {
            if (/not found on account/.test(err.message)) return { symbol, found: false }
            throw err
        }
    }

    // ── Trading ──────────────────────────────────────────────────────────────────

    capabilities() {
        return {
            trading:          true,
            nativeProtection: true,
            modifyProtection: true,
            closePosition:    true,
            cancelOrder:      true,
            listOrders:       true,
            amendOrder:       true,
            ohlcv:            true,
        }
    }

    /**
     * List the account's working (pending) LIMIT/STOP orders — the orders "in the air"
     * the user can edit or cancel. Each is tagged with the broker-canonical accountId.
     * @returns {Promise<Array<{ orderId, symbol, side, type, price, quantity, positionId, accountId }>>}
     */
    async listOrders(userId, accountId) {
        const session = await this._session(userId, accountId)
        const orders  = await session.getWorkingOrders()
        return orders.map(o => ({ ...o, accountId: String(session.ctid) }))
    }

    /**
     * Change a working order's price (ProtoOAAmendOrderReq, 2108), keeping its id.
     * Pass exactly one of limitPrice / stopPrice (matching the order's kind).
     */
    async amendOrder(userId, accountId, orderId, { limitPrice, stopPrice } = {}) {
        if (limitPrice == null && stopPrice == null) {
            throw new Error('cTrader: amendOrder requires a new limitPrice or stopPrice')
        }
        const session = await this._session(userId, accountId)

        const rec  = await session.send(PT.RECONCILE, {})
        const live = (rec?.order ?? []).find(o => String(o.orderId) === String(orderId))
        if (!live) throw new Error(`cTrader: order ${orderId} not found`)
        const td = live.tradeData ?? {}

        // Change the price by CANCEL-then-PLACE: cancel the old order first (surfacing any
        // error so a failed cancel can't leave a duplicate), then place an equivalent
        // closing order at the new price. Net result: one order at the new price.
        const specs    = await session.resolveSymbol(session.symbolNameById(td.symbolId))
        const newPrice = roundPrice(specs, Number(limitPrice ?? stopPrice))

        await session.send(PT.CANCEL_ORDER, { orderId: Number(orderId) })

        const payload = {
            symbolId:  td.symbolId,
            orderType: live.orderType,
            tradeSide: td.tradeSide,
            volume:    td.volume,
            comment:   'ar2trade',
            ...(live.positionId != null && { positionId: Number(live.positionId) }),
        }
        if (live.orderType === PROTO_ORDER_TYPE.LIMIT) payload.limitPrice = newPrice
        else                                          payload.stopPrice  = newPrice

        const res   = await session.send(PT.NEW_ORDER, payload)
        const newId = res?.order?.orderId
        logger.info(LOG, `Order ${orderId} replaced → ${newId ?? '?'} at ${newPrice}`)
        return { orderId: newId != null ? String(newId) : null }
    }

    /**
     * Place a market/limit/stop order, optionally with native SL/TP attached.
     * Native protection is sent as a relative distance (cTrader's market-order form);
     * the reference price is the limit/stop price, or order.referencePrice for market.
     * @returns {Promise<{ orderId: string, positionId?: string }>}
     */
    async placeOrder(userId, accountId, order) {
        const session = await this._session(userId, accountId)
        const specs   = await session.resolveSymbol(order.symbol)

        const orderType = ORDER_TYPE[order.type]
        const tradeSide = TRADE_SIDE[order.direction]
        if (!orderType) throw new Error(`cTrader: unsupported order type '${order.type}'`)
        if (!tradeSide) throw new Error(`cTrader: unsupported direction '${order.direction}'`)

        // order.quantity is in LOTS — convert to cTrader native volume units, then
        // align to the symbol's step and clamp to [min, max].
        const volume = normalizeVolume(specs, lotsToVolume(specs, order.quantity))
        if (volume <= 0) throw new Error(`cTrader: volume ${order.quantity} normalises to 0 for ${order.symbol}`)

        // Boundary price conversion: when the caller passes a canonical reference quote
        // (an aliased symbol whose price basis differs from the app feed — NQ vs US100),
        // shift ABSOLUTE entry prices onto the broker's book. Native SL/TP are sent as
        // RELATIVE distances below, so they stay scale-immune and are NOT shifted.
        const offset = await this._priceOffset(session, order.symbol, order.referenceQuote)

        const payload = {
            symbolId:  specs.symbolId,
            orderType,
            tradeSide,
            volume,
            comment:   'ar2trade',
        }
        if (order.type === 'limit') payload.limitPrice = roundPrice(specs, order.limitPrice + offset)
        if (order.type === 'stop')  payload.stopPrice  = roundPrice(specs, order.stopPrice  + offset)
        if (order.clientOrderId)    payload.label      = String(order.clientOrderId)

        // A positionId turns this into a CLOSING order for that position: it reduces/
        // closes the position (never opens an opposite one — essential on a hedging
        // account), is capped at the position size, and is auto-cancelled when the
        // position closes. Used for all exit orders (TP/stop levels, monitor closes).
        if (order.positionId != null) payload.positionId = Number(order.positionId)

        // Native SL/TP → relative distance from the order's reference price. The ref is
        // the CANONICAL limit/stop price (not the shifted one): a canonical-minus-canonical
        // distance is basis-immune and applies correctly to the real fill.
        if (order.stopLoss != null || order.takeProfit != null) {
            const refPrice = order.type === 'limit' ? order.limitPrice
                : order.type === 'stop'              ? order.stopPrice
                : order.referencePrice
            if (refPrice == null) {
                throw new Error('cTrader: referencePrice required to attach native SL/TP to a market order')
            }
            if (order.stopLoss   != null) payload.relativeStopLoss   = priceToRelative(refPrice - order.stopLoss)
            if (order.takeProfit != null) payload.relativeTakeProfit = priceToRelative(refPrice - order.takeProfit)
        }

        // Stream this account's fills/closes onto the bus before the order lands,
        // so the reconciler never misses a fast fill.
        this._wireExecutionFeed(session)

        const res = await session.send(PT.NEW_ORDER, payload)
        const orderId    = res?.order?.orderId
        const positionId = res?.position?.positionId
        logger.info(LOG, `Order placed: ${order.direction} ${volume} ${order.symbol} → orderId=${orderId} positionId=${positionId ?? '(pending fill)'}`)
        return {
            orderId:    String(orderId ?? ''),
            accountId:  String(session.ctid),
            ...(positionId != null && { positionId: String(positionId) }),
        }
    }

    /**
     * Amend protective SL/TP on an open position (absolute prices, 2110).
     * @param {BrokerProtection} protection  omitted fields are left unchanged
     */
    async setProtection(userId, accountId, positionId, protection = {}) {
        const session = await this._session(userId, accountId)

        // Same boundary shift as placeOrder, for ABSOLUTE amended SL/TP. Only when the
        // caller passes a canonical reference quote (aliased symbol); we resolve the
        // position's symbol to snapshot the broker spot. Dormant until a caller opts in.
        let offset = 0
        if (protection.referenceQuote != null) {
            const symbol = await this._positionSymbol(session, positionId)
            offset = symbol ? await this._priceOffset(session, symbol, protection.referenceQuote) : 0
        }

        const payload = { positionId: Number(positionId) }
        if (protection.stopLoss   != null) payload.stopLoss   = protection.stopLoss   + offset
        if (protection.takeProfit != null) payload.takeProfit = protection.takeProfit + offset
        if (payload.stopLoss == null && payload.takeProfit == null) {
            throw new Error('cTrader: setProtection requires at least one of stopLoss / takeProfit')
        }
        await session.send(PT.AMEND_SLTP, payload)
        logger.info(LOG, `Protection amended on position ${positionId}: SL=${payload.stopLoss ?? '·'} TP=${payload.takeProfit ?? '·'}`)
    }

    /**
     * Close (or partially close) an open position (2111). cTrader requires a volume,
     * so a full close looks up the position's current volume via reconcile first. On a
     * full close it FIRST cancels that position's resting closing orders (matched by
     * positionId, from the same snapshot) so none is left behind — doing it before the
     * close avoids a post-close eventual-consistency race, and matching on positionId
     * leaves a sibling position's orders (same symbol, hedging) untouched.
     * @param {{ quantity?: number }} [opts]  omit quantity to close in full
     */
    async closePosition(userId, accountId, positionId, opts = {}) {
        const session = await this._session(userId, accountId)

        if (opts.quantity != null) {
            await session.send(PT.CLOSE_POSITION, { positionId: Number(positionId), volume: opts.quantity })
            logger.info(LOG, `Partial close on position ${positionId} (volume=${opts.quantity})`)
            return
        }

        const rec = await session.send(PT.RECONCILE, {})
        const pos = (rec?.position ?? []).find(p => Number(p.positionId) === Number(positionId))
        if (!pos) throw new Error(`cTrader: position ${positionId} not found`)
        const volume = pos.tradeData?.volume
        if (volume == null) throw new Error(`cTrader: no volume for position ${positionId}`)

        const resting = (rec?.order ?? []).filter(o =>
            Number(o.positionId) === Number(positionId) &&
            (o.orderType === PROTO_ORDER_TYPE.LIMIT || o.orderType === PROTO_ORDER_TYPE.STOP))
        for (const o of resting) {
            try { await session.send(PT.CANCEL_ORDER, { orderId: Number(o.orderId) }) }
            catch (err) { logger.warn(LOG, `pre-close cancel failed (order ${o.orderId}): ${err.message}`) }
        }
        if (resting.length) logger.info(LOG, `Cancelled ${resting.length} resting order(s) before closing position ${positionId}`)

        // Hear the broker's own close (and any follow-on) events for this account.
        this._wireExecutionFeed(session)

        await session.send(PT.CLOSE_POSITION, { positionId: Number(positionId), volume })
        logger.info(LOG, `Close requested on position ${positionId} (volume=${volume})`)

        // Emit a normalized close ourselves so the reconciler flips the idea to closed
        // deterministically — independent of execution-feed timing/state. The broker's
        // own position.closed (if it also arrives) is idempotent: _onClosed only acts on
        // an idea that is still active. Reason 'manual' is overridden by a monitor-set
        // pendingCloseReason when this close came from a stop/tp.
        executionBus.emit('execution', {
            broker:     'ctrader',
            type:       'position.closed',
            accountId:  String(session.ctid),
            positionId: String(positionId),
            reason:     'manual',
            at:         Date.now(),
        })
    }

    /**
     * Cancel a working (not-yet-filled) order by its orderId (2107) — used to pull a
     * resting stop-market entry off the book. The broker echoes an ORDER_CANCELLED
     * execution event, which the reconciler ignores (the idea was already parked).
     */
    async cancelOrder(userId, accountId, orderId) {
        const session = await this._session(userId, accountId)
        await session.send(PT.CANCEL_ORDER, { orderId: Number(orderId) })
        logger.info(LOG, `Cancel requested for order ${orderId}`)
    }

    /**
     * Snapshot the broker's current spot quote for a symbol — the live cTrader price
     * used to shift an absolute order price onto cTrader's book (the basis offset vs
     * the canonical Massive feed). `symbol` is the broker's tradable name (brokerSymbol).
     * @returns {Promise<{ symbolId:number, bid:number|null, ask:number|null, mid:number, digits:number, at:number }>}
     */
    async getSpot(userId, accountId, symbol) {
        const session = await this._session(userId, accountId)
        return session.getSpotPrice(symbol)
    }

    // ── Execution feed ─────────────────────────────────────────────────────────

    async startExecutionFeed(userId, accountId) {
        const session = await this._session(userId, accountId)
        this._wireExecutionFeed(session)
        return true
    }

    /**
     * Bridge a session's raw ProtoOA execution pushes onto the shared executionBus
     * as normalized BrokerExecution events. Idempotent per account.
     */
    _wireExecutionFeed(session) {
        const key = `${session.env}:${session.ctid}`
        if (_wiredFeeds.has(key)) return
        _wiredFeeds.add(key)
        session.on('execution', payload => {
            try {
                const exec = toExecution(session, payload)
                if (exec) executionBus.emit('execution', exec)
            } catch (err) {
                logger.error(LOG, `execution translate error (${key}):`, err.message)
            }
        })
        logger.info(LOG, `Execution feed wired for ${key}`)
    }

    // ── Private ────────────────────────────────────────────────────────────────

    /**
     * Open (or reuse) the ProtoOA session for the user's trading account.
     * Resolves the ctidTraderAccountId + environment from the token, then hands the
     * session a token-getter so it can re-account-auth after a socket reconnect.
     */
    async _session(userId, accountId) {
        const tokens   = await this._freshTokens(userId)
        const accounts = await listCTraderAccounts(tokens.accessToken)
        if (accounts.length === 0) throw new Error('cTrader: no trading accounts on this connection')

        const acct = await matchCTraderAccount(userId, accountId, accounts, tokens)
        return getCTraderSession({
            ctid:           acct.ctid,
            isLive:         acct.isLive,
            getAccessToken: async () => (await this._freshTokens(userId)).accessToken,
        })
    }

    /**
     * Basis offset to shift an absolute canonical price onto the broker's book:
     * `offset = brokerSpotMid − referenceQuote`. Returns 0 when no reference quote was
     * supplied (non-aliased symbol) or the broker spot is unavailable (place at the
     * authored price rather than fail). cTraderPrice = canonicalPrice + offset.
     */
    async _priceOffset(session, symbol, referenceQuote) {
        if (referenceQuote == null) return 0
        let mid = null
        try { mid = (await session.getSpotPrice(symbol))?.mid ?? null } catch (err) {
            logger.warn(LOG, `spot snapshot failed for ${symbol}: ${err.message}`)
        }
        if (mid == null) {
            logger.warn(LOG, `no broker spot for ${symbol} — placing at canonical price (no basis shift)`)
            return 0
        }
        const offset = mid - Number(referenceQuote)
        logger.info(LOG, `basis offset ${symbol}: brokerMid=${mid} − canonical=${referenceQuote} = ${offset}`)
        return offset
    }

    /** Look up an open position's symbol name via reconcile (for the basis shift). */
    async _positionSymbol(session, positionId) {
        const rec = await session.send(PT.RECONCILE, {})
        const pos = (rec?.position ?? []).find(p => Number(p.positionId) === Number(positionId))
        const symbolId = pos?.tradeData?.symbolId
        return symbolId != null ? session.symbolNameById(symbolId) : null
    }

    // _freshTokens() is inherited from BrokerAdapter (uses brokerType/brokerLabel/provider).

    /** Resolve the user's primary trading account ID, caching in DB. */
    async _resolveAccountId(userId, tokens) {
        const cached = await brokerConnectionService.getAccountId(userId, 'ctrader')
        if (cached) return cached

        const raw  = await ctrader.get('/tradingaccounts', tokens)
        const list = asList(raw)
        if (list.length === 0) throw new Error('No cTrader trading accounts found')

        const accountId = String(list[0].id ?? list[0].accountId)
        await brokerConnectionService.setAccountId(userId, 'ctrader', accountId)
        logger.info(LOG, `Account ID ${accountId} cached for user ${userId}`)
        return accountId
    }
}


// ─── Normalisers ──────────────────────────────────────────────────────────────

function _normaliseAccount(raw) {
    return {
        id:          raw.id              ?? raw.accountId,
        login:       raw.traderLogin     ?? raw.login ?? raw.accountNumber,
        broker:      raw.brokerName      ?? raw.broker,
        currency:    raw.depositCurrency ?? raw.currency,
        balance:     money(raw.balance  ?? raw.totalBalance),
        equity:      money(raw.equity),
        margin:      money(raw.margin   ?? raw.usedMargin),
        freeMargin:  money(raw.freeMargin),
        marginLevel: num(raw.marginLevel),
        leverage:    raw.leverage != null ? Number(raw.leverage) : null,
    }
}

function _normaliseTradingAccount(raw) {
    return {
        id:       String(raw.id ?? raw.accountId ?? ''),
        login:    raw.traderLogin ?? raw.login ?? raw.accountNumber ?? null,
        currency: raw.depositCurrency ?? raw.currency ?? null,
        balance:  money(raw.balance),
        broker:   raw.brokerName ?? raw.broker ?? null,
        isLive:   !!(raw.isLive ?? !raw.isDemo),
    }
}
