/**
 * cTrader Open API — account/symbol SESSION layer (Phase 3).
 *
 * Sits between the stateless transport (ctrader.ws.provider.js → CTraderSocket)
 * and the broker adapter (Phase 4). One CTraderSocket is shared per environment
 * and multiplexes every user's account via per-account auth; a CTraderSession
 * owns everything that is scoped to a single trading account (ctidTraderAccountId):
 *
 *   • account-auth (2102) from the user's stored access token, re-issued
 *     automatically after a socket reconnect (the transport re-app-auths and
 *     emits 'authenticated' — we then re-account-auth lazily on next send).
 *   • symbol resolution: name → symbolId via the light list (2114), then full
 *     trading specs (digits, pip, min/step/max volume) via SymbolById (2116),
 *     both cached for the life of the session.
 *   • normalization primitives (volume step/min/max alignment, price rounding,
 *     absolute price → relative SL/TP distance) the adapter uses to build orders.
 *
 * The session injects `ctidTraderAccountId` into every request and forwards only
 * the execution pushes (2126) that belong to its account, so Phase 5 can wire a
 * per-account → idea-status feed without re-filtering.
 *
 * Trading message payloadTypes (verified — see project memory):
 *   2102 accountAuth · 2114 symbolsList(light) · 2116 symbolById(full specs) ·
 *   2126 executionEvent push · 2149 getAccountListByAccessToken.
 */

import { EventEmitter }      from 'node:events'
import { getCTraderSocket }  from './ctrader.ws.provider.js'
import * as ctrader          from './ctrader.provider.js'
import { logger }            from '../services/logger.service.js'
import { asList }            from '../api/broker/adapters/normalize.js'
import { normSymbol as _normSymbol, baseSymbol as _baseSymbol } from '../services/brokerSymbol.service.js'

const LOG = '[ctrader.session]'

const PT = {
    ACCOUNT_AUTH_REQ:      2102,
    SYMBOLS_LIST_REQ:      2114,
    SYMBOL_BY_ID_REQ:      2116,
    RECONCILE_REQ:         2124,   // ProtoOAReconcileReq → open positions/orders
    SUBSCRIBE_SPOTS_REQ:   2127,   // ProtoOASubscribeSpotsReq   (→ 2128 ack)
    UNSUBSCRIBE_SPOTS_REQ: 2129,   // ProtoOAUnsubscribeSpotsReq (→ 2130 ack)
    GET_ACCOUNTS_REQ:      2149,
    POSITION_PNL_REQ:      2187,   // ProtoOAGetPositionUnrealizedPnLReq (→ 2188)
}

// ProtoOAPosition.tradeData.tradeSide enum.
const TRADE_SIDE_SELL = 2

// ProtoOAOrderType enum (the working-order kinds we surface).
const ORDER_TYPE_LIMIT = 2
const ORDER_TYPE_STOP  = 3

// ProtoOASpotEvent (2131) bid/ask are integers in 1/100000 of a price unit.
const SPOT_PRICE_SCALE = 1e5
const SPOT_TIMEOUT_MS  = 5_000

// One session per (environment, account). Reused across requests so the symbol
// cache and account-auth state survive between adapter calls.
const _sessions = new Map()   // `${env}:${ctid}` → CTraderSession

/**
 * List the trading accounts granted to an access token (ProtoOA 2149).
 * Used to resolve a user's ctidTraderAccountId before opening a session.
 * @param {string}  accessToken
 * @param {boolean} [isLive]
 * @returns {Promise<Array<{ ctid: number, isLive: boolean, traderLogin: number|null }>>}
 */
export async function listCTraderAccounts(accessToken, isLive = false) {
    if (!accessToken) throw new Error('listCTraderAccounts: accessToken required')
    const socket = getCTraderSocket(isLive)
    const res = await socket.send(PT.GET_ACCOUNTS_REQ, { accessToken })
    return (res?.ctidTraderAccount ?? []).map(a => ({
        ctid:        a.ctidTraderAccountId,
        isLive:      !!a.isLive,
        traderLogin: a.traderLogin ?? null,
    }))
}

// REST trading-account id → traderLogin. The id↔login mapping is stable, so cache
// it to avoid a REST round-trip every time an order is placed by REST account id.
const _loginByRestId = new Map()   // `${userId}:${restAccountId}` → traderLogin

/**
 * Resolve a caller's accountId to a ProtoOA account ({ ctid, isLive, traderLogin }).
 * The id can arrive in two shapes:
 *   • the ctidTraderAccountId itself — what placeOrder() returns and the execution
 *     feed / reconciler pass back (fast path: direct ctid match);
 *   • a REST `/tradingaccounts` id — what ideas persist; this is NOT the ctid, so
 *     map it REST id → traderLogin → ctid (the login is the shared join key).
 * @param {string} userId
 * @param {string|number|null} accountId
 * @param {Array<{ ctid:number, isLive:boolean, traderLogin:number|null }>} protoAccounts
 * @param {object} tokens  broker tokens (for the REST lookup)
 */
export async function matchCTraderAccount(userId, accountId, protoAccounts, tokens) {
    if (accountId == null) {
        if (protoAccounts.length === 1) return protoAccounts[0]
        throw new Error('cTrader: multiple trading accounts — accountId is required')
    }

    const byCtid = protoAccounts.find(a => String(a.ctid) === String(accountId))
    if (byCtid) return byCtid

    const login = await loginForRestAccountId(userId, accountId, tokens)
    if (login != null) {
        const byLogin = protoAccounts.find(a => String(a.traderLogin) === String(login))
        if (byLogin) return byLogin
    }
    throw new Error(`cTrader: account ${accountId} not found on this connection`)
}

/** Look up a REST trading-account id's traderLogin (cached; stable mapping). */
export async function loginForRestAccountId(userId, accountId, tokens) {
    const key = `${userId}:${accountId}`
    if (_loginByRestId.has(key)) return _loginByRestId.get(key)
    try {
        const raw  = await ctrader.get('/tradingaccounts', tokens)
        const list = asList(raw)
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

/**
 * Get (or lazily create) the session for one trading account.
 * @param {Object}   opts
 * @param {number}   opts.ctid            ctidTraderAccountId (resolve via listCTraderAccounts)
 * @param {boolean}  [opts.isLive]
 * @param {() => Promise<string>|string} opts.getAccessToken  returns a CURRENT access
 *        token each time it's called — the session calls it for account-auth and
 *        for every re-auth after a reconnect, so token refresh stays in the adapter.
 * @returns {CTraderSession}
 */
export function getCTraderSession({ ctid, isLive = false, getAccessToken }) {
    if (ctid == null) throw new Error('getCTraderSession: ctid required')
    if (typeof getAccessToken !== 'function') throw new Error('getCTraderSession: getAccessToken function required')

    const env = isLive ? 'live' : 'demo'
    const key = `${env}:${ctid}`
    let session = _sessions.get(key)
    if (!session) {
        session = new CTraderSession({ ctid, isLive, getAccessToken })
        _sessions.set(key, session)
    } else {
        // Keep the token-getter fresh (a new adapter call may carry a newer closure).
        session._getAccessToken = getAccessToken
    }
    return session
}

/**
 * Account-scoped view over the shared ProtoOA socket.
 *
 * Events:
 *   'execution' — ProtoOAExecutionEvent (2126) payloads for THIS account only.
 */
export class CTraderSession extends EventEmitter {
    constructor({ ctid, isLive, getAccessToken }) {
        super()
        this.ctid    = Number(ctid)
        this.isLive  = !!isLive
        this.env     = isLive ? 'live' : 'demo'
        this._getAccessToken = getAccessToken
        this._socket = getCTraderSocket(isLive)

        this._authed = null                 // Promise once account-auth is in flight/done
        this._symbolsByName = null          // Promise<Map<name, symbolId>> (light list)
        this._namesById     = new Map()     // symbolId → name (populated with the light list)
        this._normToId      = new Map()     // normalized name (BTCUSD) → symbolId, for fuzzy lookup
        this._specsById     = new Map()     // symbolId → Promise<specs>
        this._spotInflight  = new Map()     // symbolId → Promise<Quote> (dedupes concurrent snapshots)

        // After every (re)connect the app re-authenticates; our account-auth is gone,
        // so drop it and let the next send() re-issue 2102.
        this._socket.on('authenticated', () => {
            if (this._authed) logger.info(LOG, `[${this.env}:${this.ctid}] socket re-authenticated — will re-account-auth`)
            this._authed = null
        })

        // Forward only this account's execution pushes.
        this._socket.on('execution', payload => {
            if (Number(payload?.ctidTraderAccountId) === this.ctid) this.emit('execution', payload)
        })
    }

    /** Ensure the account is authenticated on the socket (2102). Idempotent. */
    ensureAuthed() {
        if (this._authed) return this._authed
        this._authed = (async () => {
            const accessToken = await this._getAccessToken()
            if (!accessToken) throw new Error(`[${this.env}:${this.ctid}] no access token for account auth`)
            await this._socket.send(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: this.ctid, accessToken })
            logger.info(LOG, `[${this.env}:${this.ctid}] account authenticated`)
        })()
        // A failed auth must not stick — clear it so the next call retries.
        this._authed.catch(() => { this._authed = null })
        return this._authed
    }

    /**
     * Send an account-scoped request, auto-injecting ctidTraderAccountId and
     * ensuring account-auth has happened first.
     * @returns {Promise<object>} response payload
     */
    async send(payloadType, payload = {}, opts = {}) {
        await this.ensureAuthed()
        return this._socket.send(payloadType, { ctidTraderAccountId: this.ctid, ...payload }, opts)
    }

    // ── Symbols ──────────────────────────────────────────────────────────────────

    /**
     * Resolve a symbol name to its id + full trading specs (cached).
     * @param {string} symbolName  e.g. 'BTCUSD'
     * @returns {Promise<SymbolSpecs>}
     */
    async resolveSymbol(symbolName) {
        const symbolId = await this._symbolId(symbolName)
        if (symbolId == null) throw new Error(`[${this.env}:${this.ctid}] symbol '${symbolName}' not found on account`)
        return this._symbolSpecs(symbolId, symbolName)
    }

    /** Lazily load + cache the light symbol list (name → id). */
    _loadSymbols() {
        if (this._symbolsByName) return this._symbolsByName
        this._symbolsByName = (async () => {
            const res = await this.send(PT.SYMBOLS_LIST_REQ, { includeArchivedSymbols: false })
            const map = new Map()
            for (const s of res?.symbol ?? []) {
                map.set(s.symbolName, s.symbolId)
                this._namesById.set(s.symbolId, s.symbolName)
                // Index a separator-stripped form too, so an app asset like 'BTC-USD'
                // resolves to the broker's 'BTCUSD'. First writer wins on collision.
                const norm = _normSymbol(s.symbolName)
                if (norm && !this._normToId.has(norm)) this._normToId.set(norm, s.symbolId)
                // Also index the pre-suffix base, so a suffix-less alias target ('US100')
                // resolves to this broker's suffixed name ('US100.cash').
                const base = _baseSymbol(s.symbolName)
                if (base && base !== norm && !this._normToId.has(base)) this._normToId.set(base, s.symbolId)
            }
            logger.info(LOG, `[${this.env}:${this.ctid}] symbol list loaded (${map.size} symbols)`)
            return map
        })()
        this._symbolsByName.catch(() => { this._symbolsByName = null })
        return this._symbolsByName
    }

    async _symbolId(symbolName) {
        const map = await this._loadSymbols()
        // Exact broker name first; then a separator/case-insensitive fallback.
        return map.get(symbolName) ?? this._normToId.get(_normSymbol(symbolName)) ?? null
    }

    /**
     * Reverse symbol lookup (id → name) from the already-loaded light list.
     * Synchronous and non-blocking: returns null if the list hasn't loaded yet
     * (callers in hot paths, e.g. execution events, must tolerate that).
     * @param {number} symbolId
     * @returns {string|null}
     */
    symbolNameById(symbolId) {
        return this._namesById.get(Number(symbolId)) ?? null
    }

    /** Lazily fetch + cache full specs (2116) for one symbolId. */
    _symbolSpecs(symbolId, symbolName) {
        if (this._specsById.has(symbolId)) return this._specsById.get(symbolId)
        const p = (async () => {
            const res = await this.send(PT.SYMBOL_BY_ID_REQ, { symbolId: [symbolId] })
            const s   = (res?.symbol ?? [])[0]
            if (!s) throw new Error(`[${this.env}:${this.ctid}] no specs returned for symbolId ${symbolId}`)
            return _normalizeSpecs(s, symbolName)
        })()
        p.catch(() => { this._specsById.delete(symbolId) })
        this._specsById.set(symbolId, p)
        return p
    }

    // ── Spot quotes ──────────────────────────────────────────────────────────────

    /**
     * Snapshot the current spot quote for a symbol: subscribe (2127), capture the
     * first ProtoOASpotEvent (2131) tick, then unsubscribe (2129). Used at order time
     * to measure cTrader's live price against the canonical (Massive) feed, so an
     * absolute order price can be shifted to cTrader's book (the basis offset).
     *
     * Concurrent calls for the same symbol share one in-flight subscription. A spot
     * tick may carry only bid or only ask, so ticks are merged until both are seen or
     * the timeout elapses (resolves with whatever arrived; throws if nothing did).
     *
     * @param {string} symbolName  app/broker symbol name (resolved via the symbol list)
     * @returns {Promise<{ symbolId:number, bid:number|null, ask:number|null, mid:number, digits:number, at:number }>}
     */
    async getSpotPrice(symbolName) {
        const { symbolId, digits } = await this.resolveSymbol(symbolName)
        if (this._spotInflight.has(symbolId)) return this._spotInflight.get(symbolId)

        const p = this._snapshotSpot(symbolId, digits)
        this._spotInflight.set(symbolId, p)
        p.finally(() => this._spotInflight.delete(symbolId))
        return p
    }

    async _snapshotSpot(symbolId, digits) {
        let bid = null, ask = null
        let resolveTick
        const gotFullQuote = new Promise(res => { resolveTick = res })

        const onSpot = payload => {
            if (Number(payload?.ctidTraderAccountId) !== this.ctid) return
            if (Number(payload?.symbolId) !== Number(symbolId)) return
            if (payload.bid != null) bid = Number(payload.bid) / SPOT_PRICE_SCALE
            if (payload.ask != null) ask = Number(payload.ask) / SPOT_PRICE_SCALE
            if (bid != null && ask != null) resolveTick()
        }
        this._socket.on('spot', onSpot)
        const timer = setTimeout(resolveTick, SPOT_TIMEOUT_MS)   // settle with whatever we have

        try {
            await this.send(PT.SUBSCRIBE_SPOTS_REQ, { symbolId: [symbolId] })
            await gotFullQuote
        } finally {
            clearTimeout(timer)
            this._socket.off('spot', onSpot)
            // Best-effort unsubscribe so we don't leak a server-side subscription.
            this.send(PT.UNSUBSCRIBE_SPOTS_REQ, { symbolId: [symbolId] }).catch(() => {})
        }

        if (bid == null && ask == null) {
            throw new Error(`[${this.env}:${this.ctid}] no spot quote for symbolId ${symbolId} within ${SPOT_TIMEOUT_MS}ms`)
        }
        const mid   = (bid != null && ask != null) ? (bid + ask) / 2 : (bid ?? ask)
        const round = v => (v == null ? null : roundPrice({ digits }, v))
        return { symbolId, bid: round(bid), ask: round(ask), mid: round(mid), digits, at: Date.now() }
    }

    // ── Open positions ─────────────────────────────────────────────────────────

    /**
     * Snapshot the account's open positions over the ProtoOA socket (cTrader exposes
     * these only on the WebSocket, not via REST). Reconcile (2124) gives the static
     * position data; a best-effort unrealized-P&L request (2187) supplies live money
     * P&L (omitted if that call fails). Volume is converted to lots via each symbol's
     * specs; money fields are scaled by their moneyDigits.
     *
     * @returns {Promise<Array<import('../api/broker/adapters/broker.interface.js').BrokerPosition>>}
     */
    async getOpenPositions() {
        await this._loadSymbols()   // so symbolNameById() resolves
        const rec = await this.send(PT.RECONCILE_REQ, {})
        const rawPositions = rec?.position ?? []
        if (rawPositions.length === 0) return []

        const pnlById = await this._unrealizedPnL().catch(err => {
            logger.warn(LOG, `[${this.env}:${this.ctid}] unrealized P&L unavailable: ${err.message}`)
            return new Map()
        })

        return Promise.all(rawPositions.map(async p => {
            const td       = p.tradeData ?? {}
            const symbolId = td.symbolId
            const name     = symbolId != null ? this.symbolNameById(symbolId) : null

            // tradeData.volume is in cTrader native units; lotSize (same units) → lots.
            const volume = await this._volumeToLots(symbolId, name, td.volume)

            const scale = 10 ** _int(p.moneyDigits, 2)
            return {
                id:           String(p.positionId),
                symbol:       name,
                direction:    Number(td.tradeSide) === TRADE_SIDE_SELL ? 'short' : 'long',
                volume,
                entryPrice:   _num(p.price),
                currentPrice: null,
                pnl:          pnlById.get(String(p.positionId)) ?? null,
                pnlPips:      null,
                swap:         p.swap != null ? Number(p.swap) / scale : null,
                openedAt:     td.openTimestamp != null ? Number(td.openTimestamp) : null,
            }
        }))
    }

    /**
     * Convert a cTrader native volume to lots via the symbol's lotSize (same native
     * units). Falls back to the raw native volume when specs are unavailable. Shared by
     * getOpenPositions / getWorkingOrders so the conversion rule lives in one place.
     * @returns {Promise<number|null>}
     */
    async _volumeToLots(symbolId, name, rawVolume) {
        let volume = _num(rawVolume)
        if (symbolId != null) {
            try {
                const specs = await this._symbolSpecs(symbolId, name)
                if (specs?.lotSize > 0 && volume != null) volume = volume / specs.lotSize
            } catch { /* keep native volume if specs unavailable */ }
        }
        return volume
    }

    // ── Working orders ───────────────────────────────────────────────────────────

    /**
     * Snapshot the account's working (pending, not-yet-filled) LIMIT/STOP orders via
     * reconcile (2124). Volume is converted to lots like getOpenPositions; the price is
     * the order's limit or stop price (broker terms). Market orders and other kinds are
     * skipped — only the resting orders a user can see/edit are returned.
     *
     * @returns {Promise<Array<{ orderId:string, symbol:string|null, side:'long'|'short',
     *   type:'limit'|'stop', price:number|null, quantity:number|null, positionId:string|null }>>}
     */
    async getWorkingOrders() {
        await this._loadSymbols()   // so symbolNameById() resolves
        const rec = await this.send(PT.RECONCILE_REQ, {})
        const rawOrders = (rec?.order ?? []).filter(o =>
            o.orderType === ORDER_TYPE_LIMIT || o.orderType === ORDER_TYPE_STOP)
        if (rawOrders.length === 0) return []

        return Promise.all(rawOrders.map(async o => {
            const td       = o.tradeData ?? {}
            const symbolId = td.symbolId
            const name     = symbolId != null ? this.symbolNameById(symbolId) : null

            const volume = await this._volumeToLots(symbolId, name, td.volume)

            const isLimit = o.orderType === ORDER_TYPE_LIMIT
            return {
                orderId:    String(o.orderId),
                symbol:     name,
                side:       Number(td.tradeSide) === TRADE_SIDE_SELL ? 'short' : 'long',
                type:       isLimit ? 'limit' : 'stop',
                price:      _num(isLimit ? o.limitPrice : o.stopPrice),
                quantity:   volume,
                positionId: o.positionId != null ? String(o.positionId) : null,
            }
        }))
    }

    /**
     * Live net unrealized P&L per open position (ProtoOA 2187), keyed by positionId.
     * Money fields are scaled by the response's moneyDigits.
     * @returns {Promise<Map<string, number>>}
     */
    async _unrealizedPnL() {
        const res   = await this.send(PT.POSITION_PNL_REQ, {})
        const scale = 10 ** _int(res?.moneyDigits, 2)
        const map   = new Map()
        for (const u of res?.positionUnrealizedPnL ?? []) {
            const net = u.netUnrealizedPnL ?? u.grossUnrealizedPnL
            if (net != null) map.set(String(u.positionId), Number(net) / scale)
        }
        return map
    }
}

// ─── Normalization primitives ───────────────────────────────────────────────────
//
// cTrader expresses order volume as an integer in 1/100 of a unit; minVolume,
// stepVolume and maxVolume from the symbol specs use that same scale. Relative
// SL/TP distance is expressed in 1/100000 of price, independent of digits.

/**
 * @typedef {Object} SymbolSpecs
 * @property {number}  symbolId
 * @property {string}  symbolName
 * @property {number}  digits        price decimal places
 * @property {number}  pipPosition
 * @property {number}  minVolume     cTrader volume units (1/100 of a unit)
 * @property {number}  stepVolume
 * @property {number}  maxVolume
 * @property {number|null} lotSize
 */

function _normalizeSpecs(s, symbolName) {
    return {
        symbolId:    s.symbolId,
        symbolName:  s.symbolName ?? symbolName,
        digits:      _int(s.digits, 5),
        pipPosition: _int(s.pipPosition, 0),
        minVolume:   _int(s.minVolume, 0),
        stepVolume:  _int(s.stepVolume, 0),
        maxVolume:   _int(s.maxVolume, 0),
        lotSize:     Number.isFinite(Number(s.lotSize)) ? Number(s.lotSize) : null,
    }
}

/**
 * Align a desired cTrader volume to the symbol's step and clamp to [min, max].
 * @param {SymbolSpecs} specs
 * @param {number}      volume   desired volume in cTrader units
 * @returns {number}
 */
export function normalizeVolume(specs, volume) {
    let v = Number(volume)
    if (!Number.isFinite(v)) throw new Error('normalizeVolume: volume must be a finite number')

    const { stepVolume = 0, minVolume = 0, maxVolume = 0 } = specs ?? {}
    if (stepVolume > 0) v = Math.round(v / stepVolume) * stepVolume
    if (minVolume  > 0 && v < minVolume) v = minVolume
    if (maxVolume  > 0 && v > maxVolume) v = maxVolume
    return v
}

/**
 * Convert a trade size expressed in LOTS into cTrader native volume units.
 * cTrader's `lotSize` is one lot measured in those same volume units, so
 * `volume = lots × lotSize` (e.g. BTCUSD lotSize=100 → 1 lot = volume 100 = 1 BTC).
 * When the symbol advertises no lotSize the value is assumed to already be in
 * native volume units and passed through unchanged.
 * @param {SymbolSpecs} specs
 * @param {number}      lots
 * @returns {number} desired volume in cTrader units (still un-aligned; pass to normalizeVolume)
 */
export function lotsToVolume(specs, lots) {
    const n = Number(lots)
    if (!Number.isFinite(n)) throw new Error('lotsToVolume: lots must be a finite number')
    const lotSize = Number(specs?.lotSize)
    if (!Number.isFinite(lotSize) || lotSize <= 0) return n
    return n * lotSize
}

/**
 * Round a price to the symbol's tradable precision (digits).
 * @param {SymbolSpecs} specs
 * @param {number}      price
 * @returns {number}
 */
export function roundPrice(specs, price) {
    const digits = _int(specs?.digits, 5)
    const factor = 10 ** digits
    return Math.round(Number(price) * factor) / factor
}

/**
 * Convert an absolute price distance into a relative SL/TP value for a MARKET
 * order (ProtoOA relativeStopLoss / relativeTakeProfit, in 1/100000 of price).
 * @param {number} priceDistance  absolute price gap (sign ignored)
 * @returns {number} non-negative integer
 */
export function priceToRelative(priceDistance) {
    return Math.max(0, Math.round(Math.abs(Number(priceDistance)) * 1e5))
}

function _int(v, fallback) {
    const n = Number(v)
    return Number.isInteger(n) ? n : (Number.isFinite(n) ? Math.round(n) : fallback)
}

function _num(v) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
}
