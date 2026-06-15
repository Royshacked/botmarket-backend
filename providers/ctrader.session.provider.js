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
import { logger }            from '../services/logger.service.js'

const LOG = '[ctrader.session]'

const PT = {
    ACCOUNT_AUTH_REQ: 2102,
    SYMBOLS_LIST_REQ: 2114,
    SYMBOL_BY_ID_REQ: 2116,
    GET_ACCOUNTS_REQ: 2149,
}

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
        this._specsById     = new Map()     // symbolId → Promise<specs>

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
            }
            logger.info(LOG, `[${this.env}:${this.ctid}] symbol list loaded (${map.size} symbols)`)
            return map
        })()
        this._symbolsByName.catch(() => { this._symbolsByName = null })
        return this._symbolsByName
    }

    async _symbolId(symbolName) {
        const map = await this._loadSymbols()
        return map.get(symbolName) ?? null
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
