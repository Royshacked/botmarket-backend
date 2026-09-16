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
import { createTtlCache }          from '../../../services/ttlCache.util.js'
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

// TWO READS THAT HAPPENED ON EVERY OPERATION, cached for as long as their answer can be trusted.
//
// • REST /tradingaccounts — the accounts on a connection. Fetched at three sites in this file
//   (getAccount, getTradingAccounts, _resolveAccountId) and once more in the session provider, each
//   a full REST round-trip for a list that changes when the user opens or closes an account at the
//   broker, i.e. almost never. One minute is long enough to collapse a burst (a workspace read asks
//   for accounts, then the balance, then the positions) and short enough that a new account shows
//   up before the user has finished looking for it. Keyed by user, since the token is the user's.
// • ctid for (user, accountId) — what _session resolves before EVERY adapter call: a ProtoOA socket
//   round-trip (listCTraderAccounts, ProtoOA 2149) plus a possible REST lookup, to map the account
//   id an idea persisted onto the ctidTraderAccountId the socket speaks. The positions poll, every
//   order, every candle read paid it. The mapping is a fact about the account and does not move;
//   ten minutes bounds how long a re-granted connection could hand back a ctid the socket then
//   refuses — which surfaces as the auth error it is, not as a wrong account.
const ACCOUNTS_TTL_MS = 60_000
const CTID_TTL_MS     = 10 * 60_000
const _restAccounts   = createTtlCache({ ttlMs: ACCOUNTS_TTL_MS, max: 200 })   // userId → REST rows
const _ctidFor        = createTtlCache({ ttlMs: CTID_TTL_MS, max: 500 })       // `${userId}:${accountId}` → { ctid, isLive }
/** Exported for tests — nothing in production clears everything. */
export function _resetCTraderAdapterCaches() { _restAccounts.clear(); _ctidFor.clear() }
/**
 * Drop the cached answers on a (re)connect, when the account set may have changed. The user's REST
 * rows go by key; the ctid map is cleared WHOLE — it is keyed by user AND account, a TTL cache has
 * no prefix scan, and a reconnect is rare enough that every other user re-resolving once is cheaper
 * than a stale ctid being handed to the socket for ten minutes.
 */
function _forgetUser(userId) {
    _restAccounts.delete(String(userId))
    _ctidFor.clear()
}

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
        const tokens = await this._exchangeCode(code)
        await brokerConnectionService.saveConnection(userId, 'ctrader', tokens)
        // A (re)connect is the one moment the cached account answers are KNOWN to be wrong — a new
        // grant can carry a different account set — so they are dropped here rather than aged out.
        _forgetUser(userId)
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
        const list      = await this._tradingAccounts(userId, tokens)
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
        //
        // A CONNECTION failure (expired session, no accounts) THROWS, like every other read here:
        // it used to be swallowed into `[]`, so a disconnected broker looked like "no positions"
        // in the UI and tradingContext's `unavailable` list never learned the venue was down.
        // One ACCOUNT's session failing is still degraded per-account — a second account's
        // positions should not vanish because the first one's socket is unhappy.
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
        const list   = await this._tradingAccounts(userId, tokens)
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
            selfExecuted:     false,
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
     * Change a working order's price by CANCEL-then-PLACE (CancelOrder 2108 + NewOrder 2106),
     * NOT ProtoOAAmendOrderReq — so it returns a NEW orderId (the caller must relink it).
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

        // Prices arrive ALREADY in the broker's price space: the caller shifts an authored level by the
        // entity's fork-measured basisOffset (brokerPrice.applyOffset) before it gets here, so this
        // adapter rounds to the symbol's digits and nothing else. Native SL/TP below are RELATIVE
        // distances and never needed a shift.
        const payload = {
            symbolId:  specs.symbolId,
            orderType,
            tradeSide,
            volume,
            comment:   'ar2trade',
        }
        if (order.type === 'limit') payload.limitPrice = roundPrice(specs, order.limitPrice)
        if (order.type === 'stop')  payload.stopPrice  = roundPrice(specs, order.stopPrice)
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

        const payload = { positionId: Number(positionId) }
        if (protection.stopLoss   != null) payload.stopLoss   = protection.stopLoss
        if (protection.takeProfit != null) payload.takeProfit = protection.takeProfit
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

        // Always source the live position from a reconcile snapshot — for a full close it gives the
        // true native size; for a trim it also gives the symbolId needed to convert the requested
        // LOTS into native volume. (The prior partial path sent the lot count STRAIGHT THROUGH as
        // native volume, e.g. volume=2 for a 2-lot trim of a lotSize-100 symbol — closing ~1% of the
        // intended size on a live account. Trim quantity is in lots exactly like placeOrder's.)
        const rec = await session.send(PT.RECONCILE, {})
        const pos = (rec?.position ?? []).find(p => Number(p.positionId) === Number(positionId))
        if (!pos) throw new Error(`cTrader: position ${positionId} not found`)
        const totalVolume = pos.tradeData?.volume
        if (totalVolume == null) throw new Error(`cTrader: no volume for position ${positionId}`)

        let volume  = totalVolume
        let partial = false
        if (opts.quantity != null) {
            const symbolId = pos.tradeData?.symbolId
            await session._loadSymbols()   // so symbolNameById() resolves the specs label
            const specs = await session._symbolSpecs(symbolId, session.symbolNameById(symbolId))
            volume = normalizeVolume(specs, lotsToVolume(specs, opts.quantity))   // lots → native, step-aligned
            if (!(volume > 0)) throw new Error(`cTrader: trim of ${opts.quantity} lots normalises to 0 for position ${positionId}`)
            // A trim that rounds up to (or past) the whole size is just a full close — fall through.
            partial = volume < totalVolume
            if (!partial) volume = totalVolume
        }

        // Cancel the position's resting protection ONLY on a full close, so no orphan SL/TP is left
        // behind. A genuine partial keeps its resting exits — the reconciler shrinks them to the
        // remaining size when the reduce fill arrives on the (now-wired) execution feed.
        if (!partial) {
            const resting = (rec?.order ?? []).filter(o =>
                Number(o.positionId) === Number(positionId) &&
                (o.orderType === PROTO_ORDER_TYPE.LIMIT || o.orderType === PROTO_ORDER_TYPE.STOP))
            for (const o of resting) {
                try { await session.send(PT.CANCEL_ORDER, { orderId: Number(o.orderId) }) }
                catch (err) { logger.warn(LOG, `pre-close cancel failed (order ${o.orderId}): ${err.message}`) }
            }
            if (resting.length) logger.info(LOG, `Cancelled ${resting.length} resting order(s) before closing position ${positionId}`)
        }

        // Hear the broker's own execution events for this account (the reduce/close fill + follow-ons).
        this._wireExecutionFeed(session)

        await session.send(PT.CLOSE_POSITION, { positionId: Number(positionId), volume })
        logger.info(LOG, `${partial ? 'Partial close' : 'Close'} on position ${positionId} (volume=${volume}${partial ? ` from ${opts.quantity} lots` : ''})`)

        // Emit a normalized close ourselves so the reconciler flips the idea to closed
        // deterministically — independent of execution-feed timing/state. The broker's
        // own position.closed (if it also arrives) is idempotent: _onClosed only acts on
        // an idea that is still active. Reason 'manual' is overridden by a monitor-set
        // pendingCloseReason when this close came from a stop/tp.
        // A PARTIAL does NOT self-emit: the idea stays open and the real reduce fill from the wired
        // feed carries the true remaining size (which the reconciler needs to resync exits) — a
        // synthetic reduced event with no fill size would misinform it.
        if (!partial) {
            executionBus.emit('execution', {
                broker:     'ctrader',
                type:       'position.closed',
                accountId:  String(session.ctid),
                positionId: String(positionId),
                reason:     'manual',
                at:         Date.now(),
            })
        }
    }

    /**
     * Cancel a working (not-yet-filled) order by its orderId (CancelOrder, 2108) — used to pull a
     * resting stop-market entry off the book. The broker echoes an ORDER_CANCELLED
     * execution event, which the reconciler ignores (the idea was already parked).
     */
    async cancelOrder(userId, accountId, orderId) {
        const session = await this._session(userId, accountId)
        await session.send(PT.CANCEL_ORDER, { orderId: Number(orderId) })
        logger.info(LOG, `Cancel requested for order ${orderId}`)
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
        const key = `${userId}:${accountId ?? ''}`
        let acct = _ctidFor.get(key)
        if (!acct) {
            const tokens   = await this._freshTokens(userId)
            const accounts = await listCTraderAccounts(tokens.accessToken)
            if (accounts.length === 0) throw new Error('cTrader: no trading accounts on this connection')
            const matched = await matchCTraderAccount(userId, accountId, accounts, tokens)
            acct = { ctid: matched.ctid, isLive: matched.isLive }
            _ctidFor.set(key, acct)
        }
        return getCTraderSession({
            ctid:           acct.ctid,
            isLive:         acct.isLive,
            getAccessToken: async () => (await this._freshTokens(userId)).accessToken,
        })
    }

    /** The REST /tradingaccounts rows for this user, cached a minute. See the caches at the top. */
    async _tradingAccounts(userId, tokens) {
        const hit = _restAccounts.get(String(userId))
        if (hit) return hit
        const list = asList(await this._restGet('/tradingaccounts', tokens))
        _restAccounts.set(String(userId), list)
        return list
    }

    // The two provider calls a test stands in for, as methods — the same seam shape as _session
    // above (ESM namespaces are frozen, so a provider cannot be stubbed at the import).
    _restGet(path, tokens)  { return ctrader.get(path, tokens) }
    _exchangeCode(code)     { return ctrader.exchangeCode(code) }


    /** Resolve the user's primary trading account ID, caching in DB. */
    async _resolveAccountId(userId, tokens) {
        const cached = await brokerConnectionService.getAccountId(userId, 'ctrader')
        if (cached) return cached

        const list = await this._tradingAccounts(userId, tokens)
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

export function _normaliseTradingAccount(raw) {
    return {
        id:       String(raw.id ?? raw.accountId ?? ''),
        login:    raw.traderLogin ?? raw.login ?? raw.accountNumber ?? null,
        currency: raw.depositCurrency ?? raw.currency ?? null,
        balance:  money(raw.balance),
        // What is actually DEPLOYABLE. Balance counts capital already committed to open positions, so
        // an agent sizing a new book against it spends the same money twice. This list is the only
        // account shape the agents ever see — the richer read that carried freeMargin is a different
        // call they never make. null when the payload doesn't carry it, which the renderers treat as
        // "not reported" and fall back to balance rather than inventing a figure.
        freeMargin: money(raw.freeMargin),
        equity:     money(raw.equity),
        broker:   raw.brokerName ?? raw.broker ?? null,
        isLive:   !!(raw.isLive ?? !raw.isDemo),
    }
}
