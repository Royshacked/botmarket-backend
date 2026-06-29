/**
 * IBKR TWS API — STATEFUL trading transport (socket to IB Gateway / TWS).
 *
 * Companion to ibkr.provider.js (the older stateless Client Portal REST client,
 * kept only for historical bars until Phase 2 retires it). This file owns the
 * persistent socket used for everything else: account, positions, candles,
 * orders, and the execution feed — all over one connection, via @stoqey/ib.
 *
 * SCOPE (Phase 1) — transport + connection lifecycle. It knows nothing about our
 * unified contracts; the adapter layer normalizes. It exposes promise-based
 * request helpers (reqId-correlated) and re-emits IB's push events so later
 * phases can translate fills onto the executionBus.
 *
 * Unlike cTrader (OAuth, hosted), IB Gateway is a LOCAL process you log into
 * yourself: one running gateway = one IB account. The "connection" is therefore
 * just coordinates { host, port, clientId } — no tokens. Paper vs live is chosen
 * by which gateway port you point at:
 *   IB Gateway  paper 4002 / live 4001     TWS  paper 7497 / live 7496
 *
 * One socket per { host:port:clientId }, created lazily and reused.
 */

import { EventEmitter }          from 'node:events'
import { IBApi, EventName, ErrorCode, WhatToShow, MarketDataType } from '@stoqey/ib'
import { logger }                from '../services/logger.service.js'

const LOG = '[ibkr.gateway]'

const REQUEST_TIMEOUT_MS = 15_000
const RECONNECT_BASE_MS  = 1_000
const RECONNECT_MAX_MS   = 30_000

// IB tags we pull for an account summary (maps to BrokerAccount in the adapter).
export const ACCOUNT_TAGS = [
    'NetLiquidation', 'TotalCashValue', 'AvailableFunds',
    'InitMarginReq', 'MaintMarginReq', 'ExcessLiquidity', 'BuyingPower',
].join(',')

// One gateway socket per coordinate set, created lazily.
const _clients = new Map()   // 'host:port:clientId' → IBKRGateway

/**
 * Get the shared gateway socket for a set of coordinates. Lazily created; call
 * `.ready` (or any request helper) to ensure it's connected.
 * @param {{ host?: string, port?: number, clientId?: number }} [coords]
 * @returns {IBKRGateway}
 */
export function getIBKRGateway(coords = {}) {
    const host     = coords.host     ?? process.env.IBKR_GW_HOST     ?? '127.0.0.1'
    const port     = Number(coords.port     ?? process.env.IBKR_GW_PORT     ?? 4002)
    const clientId = Number(coords.clientId ?? process.env.IBKR_GW_CLIENTID ?? 1)
    const key      = `${host}:${port}:${clientId}`
    if (!_clients.has(key)) _clients.set(key, new IBKRGateway({ host, port, clientId }))
    return _clients.get(key)
}

/**
 * Persistent socket to one IB Gateway / TWS.
 *
 * Events re-emitted for higher layers (Phase 3 translates these onto executionBus):
 *   'execDetails'    — (reqId, contract, execution)  a fill
 *   'orderStatus'    — (orderId, status, filled, remaining, avgFillPrice, …)
 *   'commissionReport' — realized pnl / commission for a fill
 *   'openOrder'      — (orderId, contract, order, orderState)
 *   'position'       — (account, contract, pos, avgCost)   global subscription
 */
export class IBKRGateway extends EventEmitter {
    constructor({ host, port, clientId }) {
        super()
        this.host     = host
        this.port     = port
        this.clientId = clientId

        this._api          = null
        this._reqSeq       = 0          // data-request ids (account/contract/history)
        this._nextOrderId  = null       // IB-assigned order-id sequence (nextValidId)
        this._attempts     = 0
        this._stopped      = false
        this._ready        = null
        this._resolveReady = null
        this._rejectReady  = null
    }

    /** Promise that resolves once connected and IB has issued the first orderId. */
    get ready() {
        if (!this._ready) this.start()
        return this._ready
    }

    /** Idempotent connect. */
    start() {
        if (this._api) return
        this._stopped = false
        if (!this._ready) this._armReady()
        this._connect()
    }

    /** Re-arm the `ready` gate so callers block until the next successful connect. */
    _armReady() {
        this._ready = new Promise((resolve, reject) => {
            this._resolveReady = resolve
            this._rejectReady  = reject
        })
        this._ready.catch(() => {})   // no unobserved-rejection crash during reconnects
    }

    /** Graceful shutdown. */
    stop() {
        this._stopped = true
        if (this._api) { try { this._api.disconnect() } catch {} this._api = null }
    }

    _connect() {
        if (!this._ready) this._armReady()
        logger.info(LOG, `connecting ${this.host}:${this.port} (clientId ${this.clientId})`)

        const api = new IBApi({ host: this.host, port: this.port, clientId: this.clientId })
        this._api = api

        // First nextValidId after connect is IB's "you're ready" signal (analogous to
        // cTrader's app-auth ack). It also seeds the order-id sequence for placeOrder.
        api.once(EventName.nextValidId, (orderId) => {
            this._nextOrderId = orderId
            this._attempts    = 0
            // Paper accounts usually lack live-data subscriptions; delayed data lets
            // historical bars + snapshots work without one (fine for MVP verification).
            try { api.reqMarketDataType(MarketDataType.DELAYED) } catch {}
            logger.info(LOG, `connected — nextValidId ${orderId}`)
            this._resolveReady()
            this.emit('connected')
        })

        api.on(EventName.error, (err, code, reqId) => this._onError(err, code, reqId))
        api.on(EventName.disconnected, () => this._onClose())

        // Re-emit push events untouched; the adapter (Phase 3) translates them.
        for (const ev of ['execDetails', 'commissionReport', 'orderStatus', 'openOrder', 'position']) {
            api.on(EventName[ev], (...args) => this.emit(ev, ...args))
        }

        try { api.connect() } catch (err) { this._onError(err, ErrorCode.CONNECT_FAIL, -1) }
    }

    _onError(err, code, reqId) {
        // reqId-scoped errors are handled by the pending request's own listener.
        // Here we only deal with connection-level failures (reqId === -1) and the
        // benign "market data farm connected" info codes IB sends as errors.
        if (reqId !== undefined && reqId >= 0) return
        if (_isInfo(code)) { logger.info(LOG, `info ${code}: ${err?.message ?? ''}`); return }

        logger.error(LOG, `connection error ${code}: ${err?.message ?? err}`)
        if (this._rejectReady) this._rejectReady(Object.assign(new Error(`IBKR gateway: ${err?.message ?? err}`), { status: 502 }))
        this._scheduleReconnect()
    }

    _onClose() {
        logger.warn(LOG, 'gateway socket closed')
        try { this._api?.disconnect() } catch {}
        this._api = null
        if (this._stopped) return
        this._armReady()
        this._scheduleReconnect()
    }

    _scheduleReconnect() {
        if (this._stopped) return
        if (this._api) { try { this._api.disconnect() } catch {} this._api = null }
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** this._attempts++, RECONNECT_MAX_MS)
        logger.info(LOG, `reconnecting in ${delay}ms (attempt ${this._attempts})`)
        setTimeout(() => { if (!this._stopped) this._connect() }, delay)
    }

    // ── Request helpers ──────────────────────────────────────────────────────────

    /** Allocate a fresh data-request id. */
    _nextReqId() { return ++this._reqSeq }

    /** Reserve the next IB order id (advances the local sequence). */
    nextOrderId() {
        if (this._nextOrderId == null) throw new Error('IBKR gateway: order-id sequence not ready')
        return this._nextOrderId++
    }

    get api() { return this._api }

    /**
     * Run a reqId-correlated request that streams rows via `dataEvent` and finishes
     * on `endEvent` (both carrying reqId as their first arg). Resolves the collected
     * rows (each row = the event's args after reqId). Rejects on a matching error or
     * timeout. Works for accountSummary, contractDetails, historicalData, etc.
     * @returns {Promise<any[][]>}
     */
    async collect(dataEvent, endEvent, fire, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
        await this.ready
        const api   = this._api
        const reqId = this._nextReqId()

        return new Promise((resolve, reject) => {
            const rows = []
            const onData = (rid, ...rest) => { if (rid === reqId) rows.push(rest) }
            const onEnd  = (rid)          => { if (rid === reqId) finish(null, rows) }
            const onErr  = (err, code, rid) => { if (rid === reqId) finish(_reqError(err, code)) }

            const timer = setTimeout(() => finish(new Error(`IBKR gateway: timeout on ${dataEvent}`)), timeoutMs)
            const finish = (err, val) => {
                clearTimeout(timer)
                api.off(EventName[dataEvent], onData)
                api.off(EventName[endEvent], onEnd)
                api.off(EventName.error, onErr)
                err ? reject(err) : resolve(val)
            }

            api.on(EventName[dataEvent], onData)
            api.on(EventName[endEvent], onEnd)
            api.on(EventName.error, onErr)
            try { fire(reqId) } catch (err) { finish(err) }
        })
    }

    /**
     * Fetch a one-shot account summary for the given group ('All' for the gateway's
     * only account). Returns raw [account, tag, value, currency] rows.
     * @param {string} [group]
     * @returns {Promise<Array<[string,string,string,string]>>}
     */
    async reqAccountSummary(group = 'All') {
        const rows = await this.collect(
            'accountSummary',
            'accountSummaryEnd',
            (reqId) => this._api.reqAccountSummary(reqId, group, ACCOUNT_TAGS),
        )
        // accountSummary args after reqId: (account, tag, value, currency)
        return rows
    }

    /**
     * Resolve a contract to its full IB definitions (conId, expiry, multiplier, …).
     * Returns the array of matching ContractDetails (a future symbol yields one per
     * expiry; the adapter picks the front month).
     * @param {object} contract  partial IB Contract
     * @returns {Promise<object[]>}
     */
    async reqContractDetails(contract) {
        const rows = await this.collect(
            'contractDetails',
            'contractDetailsEnd',
            (reqId) => this._api.reqContractDetails(reqId, contract),
        )
        return rows.map(([details]) => details)   // each row = [contractDetails]
    }

    /**
     * One-shot snapshot of all open positions (account-wide; IB's `position` feed
     * carries no reqId, so this can't use collect()). Single-flighted.
     * @returns {Promise<Array<{ account: string, contract: object, pos: number, avgCost: number }>>}
     */
    async reqPositions({ timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
        await this.ready
        if (this._positionsPromise) return this._positionsPromise
        const api = this._api

        this._positionsPromise = new Promise((resolve, reject) => {
            const rows = []
            const onPos = (account, contract, pos, avgCost) => rows.push({ account, contract, pos: Number(pos), avgCost: Number(avgCost) })
            const onEnd = () => finish(null, rows)
            const timer = setTimeout(() => finish(new Error('IBKR gateway: timeout on positions')), timeoutMs)
            const finish = (err, val) => {
                clearTimeout(timer)
                api.off(EventName.position, onPos)
                api.off(EventName.positionEnd, onEnd)
                try { api.cancelPositions() } catch {}
                this._positionsPromise = null
                err ? reject(err) : resolve(val)
            }
            api.on(EventName.position, onPos)
            api.once(EventName.positionEnd, onEnd)
            try { api.reqPositions() } catch (err) { finish(err) }
        })
        return this._positionsPromise
    }

    /**
     * Fetch historical OHLCV bars. Completion is signalled by a terminal record whose
     * date begins with "finished" (this lib has no historicalDataEnd event).
     * formatDate=2 → dates arrive as UNIX epoch seconds.
     * @param {object} contract  a qualified IB Contract
     * @param {{ duration: string, barSize: string, whatToShow?: string, useRTH?: boolean }} opts
     * @returns {Promise<Array<{t,o,h,l,c,v}>>}
     */
    async reqHistoricalBars(contract, { duration, barSize, whatToShow = WhatToShow.TRADES, useRTH = false, timeoutMs = 30_000 }) {
        await this.ready
        const api   = this._api
        const reqId = this._nextReqId()

        return new Promise((resolve, reject) => {
            const bars = []
            const onData = (rid, date, open, high, low, close, volume) => {
                if (rid !== reqId) return
                if (typeof date === 'string' && date.startsWith('finished')) return finish(null, bars)
                bars.push({
                    t: Number(date) * 1000,
                    o: Number(open), h: Number(high), l: Number(low), c: Number(close),
                    v: Number(volume),
                })
            }
            const onErr = (err, code, rid) => { if (rid === reqId) finish(_reqError(err, code)) }
            const timer = setTimeout(() => finish(new Error('IBKR gateway: timeout on historical data')), timeoutMs)
            const finish = (err, val) => {
                clearTimeout(timer)
                api.off(EventName.historicalData, onData)
                api.off(EventName.error, onErr)
                err ? reject(err) : resolve(val)
            }
            api.on(EventName.historicalData, onData)
            api.on(EventName.error, onErr)
            try {
                api.reqHistoricalData(reqId, contract, '', duration, barSize, whatToShow, useRTH ? 1 : 0, 2, false)
            } catch (err) { finish(err) }
        })
    }

    /**
     * Best-effort single-position P&L snapshot. Resolves null on timeout/error or when
     * IB returns its "unavailable" sentinel (paper accounts without a data subscription).
     * @param {string} account
     * @param {number} conId
     * @returns {Promise<{ unrealizedPnL: number|null, value: number|null }|null>}
     */
    async reqPnlSingle(account, conId, { timeoutMs = 4_000 } = {}) {
        await this.ready
        const api   = this._api
        const reqId = this._nextReqId()

        return new Promise((resolve) => {
            const onData = (rid, _pos, _daily, unrealizedPnL, _realized, value) => {
                if (rid !== reqId) return
                done({ unrealizedPnL: _sane(unrealizedPnL), value: _sane(value) })
            }
            const timer = setTimeout(() => done(null), timeoutMs)
            const done = (val) => {
                clearTimeout(timer)
                api.off(EventName.pnlSingle, onData)
                try { api.cancelPnLSingle(reqId) } catch {}
                resolve(val)
            }
            api.on(EventName.pnlSingle, onData)
            try { api.reqPnLSingle(reqId, account, '', conId) } catch { done(null) }
        })
    }
}

// IB sends a batch of "errors" on connect that are actually informational
// (market-data farm connection status). Don't treat them as failures.
function _isInfo(code) {
    return code === 2104 || code === 2106 || code === 2107
        || code === 2108 || code === 2158 || code === 2119
}

function _reqError(err, code) {
    const e = new Error(`IBKR ${code}: ${err?.message ?? err}`)
    e.code = code
    return e
}

// IB reports unavailable P&L / market values as a Double.MAX sentinel (~1.8e308).
// Treat those — and any non-finite value — as null.
function _sane(v) {
    const n = Number(v)
    return Number.isFinite(n) && Math.abs(n) < 1e17 ? n : null
}
