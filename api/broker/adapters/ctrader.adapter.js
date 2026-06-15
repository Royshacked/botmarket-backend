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
 * protocol, NOT on the REST API we use here. So getCandles() returns null
 * and the monitoring system falls back to Massive/Polygon.
 */

import { BrokerAdapter }           from './broker.interface.js'
import * as ctrader                from '../../../providers/ctrader.provider.js'
import { brokerConnectionService } from '../brokerConnection.service.js'
import { logger }                  from '../../../services/logger.service.js'
import { executionBus }            from '../../../services/executionBus.js'
import {
    listCTraderAccounts,
    getCTraderSession,
    normalizeVolume,
    lotsToVolume,
    roundPrice,
    priceToRelative,
} from '../../../providers/ctrader.session.provider.js'

const LOG = '[ctrader.adapter]'

// ProtoOA enums (sent as integers in JSON).
const ORDER_TYPE   = { market: 1, limit: 2, stop: 3 }
const TRADE_SIDE   = { long: 1, short: 2 }
const PT = {
    NEW_ORDER:      2106,   // ProtoOANewOrderReq
    AMEND_SLTP:     2110,   // ProtoOAAmendPositionSLTPReq (absolute prices)
    CLOSE_POSITION: 2111,   // ProtoOAClosePositionReq (requires volume)
    RECONCILE:      2124,   // ProtoOAReconcileReq → open positions/orders
}

// Inbound ProtoOA enums for translating ProtoOAExecutionEvent (2126).
const EXEC_TYPE = {       // ProtoOAExecutionType
    ORDER_ACCEPTED: 2, ORDER_FILLED: 3, ORDER_CANCELLED: 5,
    ORDER_EXPIRED: 6, ORDER_REJECTED: 7, ORDER_PARTIAL_FILL: 11,
}
const POSITION_STATUS  = { OPEN: 1, CLOSED: 2 }   // ProtoOAPositionStatus
const PROTO_ORDER_TYPE = { LIMIT: 2, STOP: 3 }    // a TP closes via LIMIT, an SL via STOP
const MONEY_SCALE      = 100   // ProtoOA money fields are integer cents (moneyDigits=2)

// Module-level so the idempotency guard survives the factory minting a fresh
// adapter per call — the listener lives on the cached (singleton) session.
const _wiredFeeds = new Set()  // `${env}:${ctid}`

// REST trading-account id → traderLogin. The id↔login mapping is stable, so cache
// it to avoid a REST round-trip every time an order is placed by REST account id.
const _loginByRestId = new Map()   // `${userId}:${restAccountId}` → traderLogin

export class CTraderAdapter extends BrokerAdapter {

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
        const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []
        const account = list.find(a => String(a.id ?? a.accountId) === String(accountId))
        if (!account) throw new Error(`cTrader account ${accountId} not found in accounts list`)
        return _normaliseAccount(account)
    }

    // ── Positions ──────────────────────────────────────────────────────────────

    async getPositions(userId) {
        const tokens    = await this._freshTokens(userId)
        const accountId = await this._resolveAccountId(userId, tokens)
        try {
            const raw  = await ctrader.get(`/tradingaccounts/${accountId}/openpositions`, tokens)
            const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []
            return list.map(_normalisePosition)
        } catch {
            // cTrader open positions may not be accessible via REST (WebSocket only)
            return []
        }
    }

    // ── Trading accounts ───────────────────────────────────────────────────────

    async getTradingAccounts(userId) {
        const tokens = await this._freshTokens(userId)
        const raw    = await ctrader.get('/tradingaccounts', tokens)
        const list   = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []
        return list.map(_normaliseTradingAccount)
    }

    // ── Candles — not supported via REST ──────────────────────────────────────
    // Returns null → caller falls back to Massive/Polygon
    async getCandles() { return null }

    // ── Trading ──────────────────────────────────────────────────────────────────

    capabilities() {
        return {
            trading:          true,
            nativeProtection: true,
            modifyProtection: true,
            closePosition:    true,
            ohlcv:            false,
        }
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

        // Native SL/TP → relative distance from the order's reference price.
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
     * so a full close looks up the position's current volume via reconcile first.
     * @param {{ quantity?: number }} [opts]  omit quantity to close in full
     */
    async closePosition(userId, accountId, positionId, opts = {}) {
        const session = await this._session(userId, accountId)
        const volume  = opts.quantity != null
            ? opts.quantity
            : await this._positionVolume(session, positionId)
        await session.send(PT.CLOSE_POSITION, { positionId: Number(positionId), volume })
        logger.info(LOG, `Close requested on position ${positionId} (volume=${volume})`)
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
                const exec = this._toExecution(session, payload)
                if (exec) executionBus.emit('execution', exec)
            } catch (err) {
                logger.error(LOG, `execution translate error (${key}):`, err.message)
            }
        })
        logger.info(LOG, `Execution feed wired for ${key}`)
    }

    /**
     * Translate a ProtoOAExecutionEvent (2126) into a normalized BrokerExecution,
     * or null for events the reconciler doesn't care about (swaps, deposits, acks).
     * @returns {import('./broker.interface.js').BrokerExecution|null}
     */
    _toExecution(session, p) {
        const order    = p?.order ?? {}
        const deal     = p?.deal ?? {}
        const position = p?.position ?? {}
        const closeDetail = deal.closePositionDetail ?? null

        const positionId = position.positionId ?? deal.positionId ?? order.positionId
        const symbolId   = order.tradeData?.symbolId ?? position.tradeData?.symbolId
        const tradeSide  = position.tradeData?.tradeSide ?? order.tradeData?.tradeSide

        const base = {
            broker:    'ctrader',
            accountId: String(p?.ctidTraderAccountId ?? session.ctid),
            at:        Number(deal.executionTimestamp ?? p?.timestamp ?? Date.now()),
            ...(order.orderId   != null && { orderId:    String(order.orderId) }),
            ...(positionId      != null && { positionId: String(positionId) }),
            ...(symbolId        != null && { symbol: session.symbolNameById(symbolId) ?? undefined }),
            ...(tradeSide       != null && { direction: tradeSide === TRADE_SIDE.short ? 'short' : 'long' }),
        }

        switch (p?.executionType) {
            case EXEC_TYPE.ORDER_REJECTED:
                return { ...base, type: 'order.rejected' }
            case EXEC_TYPE.ORDER_CANCELLED:
            case EXEC_TYPE.ORDER_EXPIRED:
                return { ...base, type: 'order.cancelled' }
            case EXEC_TYPE.ORDER_FILLED:
            case EXEC_TYPE.ORDER_PARTIAL_FILL: {
                const closing = position.positionStatus === POSITION_STATUS.CLOSED
                    || order.closingOrder === true || closeDetail != null
                if (closing) {
                    return {
                        ...base,
                        type:   'position.closed',
                        reason: _closeReason(order),
                        ...(deal.executionPrice != null && { price: deal.executionPrice }),
                        ...(deal.filledVolume   != null && { quantity: deal.filledVolume }),
                        ...(closeDetail?.profit != null && { pnl: closeDetail.profit / MONEY_SCALE }),
                    }
                }
                // A fill that doesn't close → a new/added position.
                return {
                    ...base,
                    type: position.positionStatus === POSITION_STATUS.OPEN ? 'position.opened' : 'order.filled',
                    ...(deal.executionPrice  != null && { price: deal.executionPrice }),
                    ...(deal.filledVolume    != null && { quantity: deal.filledVolume }),
                    ...(position.stopLoss    != null && { stopLoss: position.stopLoss }),
                    ...(position.takeProfit  != null && { takeProfit: position.takeProfit }),
                }
            }
            default:
                return null   // ORDER_ACCEPTED, SWAP, DEPOSIT_WITHDRAW, … — not reconciled
        }
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

        const acct = await this._matchAccount(userId, accountId, accounts, tokens)
        return getCTraderSession({
            ctid:           acct.ctid,
            isLive:         acct.isLive,
            getAccessToken: async () => (await this._freshTokens(userId)).accessToken,
        })
    }

    /**
     * Resolve the caller's accountId to a ProtoOA account ({ ctid, isLive, traderLogin }).
     * The id can arrive in two shapes:
     *   • the ctidTraderAccountId itself — what placeOrder() returns and the execution
     *     feed / reconciler pass back (fast path: direct ctid match);
     *   • a REST `/tradingaccounts` id — what ideas persist; this is NOT the ctid, so
     *     map it REST id → traderLogin → ctid (the login is the shared join key).
     */
    async _matchAccount(userId, accountId, protoAccounts, tokens) {
        if (accountId == null) {
            if (protoAccounts.length === 1) return protoAccounts[0]
            throw new Error('cTrader: multiple trading accounts — accountId is required')
        }

        const byCtid = protoAccounts.find(a => String(a.ctid) === String(accountId))
        if (byCtid) return byCtid

        const login = await this._loginForRestAccountId(userId, accountId, tokens)
        if (login != null) {
            const byLogin = protoAccounts.find(a => String(a.traderLogin) === String(login))
            if (byLogin) return byLogin
        }
        throw new Error(`cTrader: account ${accountId} not found on this connection`)
    }

    /** Look up a REST trading-account id's traderLogin (cached; stable mapping). */
    async _loginForRestAccountId(userId, accountId, tokens) {
        const key = `${userId}:${accountId}`
        if (_loginByRestId.has(key)) return _loginByRestId.get(key)
        try {
            const raw  = await ctrader.get('/tradingaccounts', tokens)
            const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []
            for (const a of list) {
                const id    = String(a.id ?? a.accountId ?? '')
                const login = a.traderLogin ?? a.login ?? a.accountNumber ?? null
                if (id && login != null) _loginByRestId.set(`${userId}:${id}`, login)
            }
            return _loginByRestId.get(key) ?? null
        } catch (err) {
            logger.warn(LOG, `REST account lookup failed for ${accountId}: ${err.message}`)
            return null
        }
    }

    /** Look up an open position's current volume (for a full close). */
    async _positionVolume(session, positionId) {
        const rec = await session.send(PT.RECONCILE, {})
        const pos = (rec?.position ?? []).find(p => Number(p.positionId) === Number(positionId))
        if (!pos) throw new Error(`cTrader: position ${positionId} not found`)
        const volume = pos.tradeData?.volume
        if (volume == null) throw new Error(`cTrader: position ${positionId} has no volume`)
        return volume
    }

    /** Return valid tokens for this user, refreshing if within 60s of expiry. */
    async _freshTokens(userId) {
        const conn = await brokerConnectionService.getConnection(userId, 'ctrader')
        if (!conn) {
            throw Object.assign(new Error('cTrader not connected'), { status: 401 })
        }

        const bufferMs = 60_000
        if (Date.now() + bufferMs >= conn.expiresAt) {
            logger.info(LOG, `Refreshing tokens for user ${userId}`)
            try {
                const fresh = await ctrader.refreshTokens(conn)
                await brokerConnectionService.updateTokens(userId, 'ctrader', fresh)
                return fresh
            } catch (err) {
                logger.error(LOG, `Token refresh failed for user ${userId}:`, err.message)
                throw Object.assign(new Error('cTrader session expired — please reconnect'), { status: 401 })
            }
        }
        return conn
    }

    /** Resolve the user's primary trading account ID, caching in DB. */
    async _resolveAccountId(userId, tokens) {
        const cached = await brokerConnectionService.getAccountId(userId, 'ctrader')
        if (cached) return cached

        const raw  = await ctrader.get('/tradingaccounts', tokens)
        const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []
        if (list.length === 0) throw new Error('No cTrader trading accounts found')

        const accountId = String(list[0].id ?? list[0].accountId)
        await brokerConnectionService.setAccountId(userId, 'ctrader', accountId)
        logger.info(LOG, `Account ID ${accountId} cached for user ${userId}`)
        return accountId
    }
}

// Infer why a position closed from the order that closed it: a native take-profit
// is a LIMIT order, a native stop-loss is a STOP order; anything else (a manual
// market close) we can't attribute, so report 'manual'.
function _closeReason(order) {
    if (order?.orderType === PROTO_ORDER_TYPE.LIMIT) return 'tp'
    if (order?.orderType === PROTO_ORDER_TYPE.STOP)  return 'stop'
    return 'manual'
}

// ─── Normalisers ──────────────────────────────────────────────────────────────

function _normaliseAccount(raw) {
    return {
        id:          raw.id              ?? raw.accountId,
        login:       raw.traderLogin     ?? raw.login ?? raw.accountNumber,
        broker:      raw.brokerName      ?? raw.broker,
        currency:    raw.depositCurrency ?? raw.currency,
        balance:     _money(raw.balance  ?? raw.totalBalance),
        equity:      _money(raw.equity),
        margin:      _money(raw.margin   ?? raw.usedMargin),
        freeMargin:  _money(raw.freeMargin),
        marginLevel: _num(raw.marginLevel),
        leverage:    raw.leverage != null ? Number(raw.leverage) : null,
    }
}

function _normalisePosition(raw) {
    return {
        id:           raw.id ?? raw.positionId,
        symbol:       raw.symbolName ?? raw.symbol,
        direction:    (raw.tradeSide ?? raw.side)?.toLowerCase() === 'sell' ? 'short' : 'long',
        volume:       _num(raw.volume),
        entryPrice:   _num(raw.entryPrice ?? raw.openPrice),
        currentPrice: _num(raw.currentPrice),
        pnl:          _money(raw.pnl ?? raw.grossProfit),
        pnlPips:      _num(raw.pnlPips),
        swap:         _money(raw.swap),
        openedAt:     raw.openTimestamp ?? raw.createTimestamp,
    }
}

function _normaliseTradingAccount(raw) {
    return {
        id:       String(raw.id ?? raw.accountId ?? ''),
        login:    raw.traderLogin ?? raw.login ?? raw.accountNumber ?? null,
        currency: raw.depositCurrency ?? raw.currency ?? null,
        balance:  _money(raw.balance),
        broker:   raw.brokerName ?? raw.broker ?? null,
        isLive:   !!(raw.isLive ?? !raw.isDemo),
    }
}

// cTrader REST API returns monetary values in cents (divide by 100 to get account currency)
function _money(v) {
    const n = Number(v)
    return Number.isFinite(n) ? n / 100 : null
}

function _num(v) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
}
