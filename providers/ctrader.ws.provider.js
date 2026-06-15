/**
 * cTrader Open API — STATEFUL trading transport (ProtoOA over JSON WebSocket).
 *
 * Companion to ctrader.provider.js (stateless REST for OAuth + accounts). This file
 * owns the persistent socket(s) used for trading: connection, application auth,
 * heartbeat, reconnect-with-backoff, and request/response correlation.
 *
 * SCOPE (Phase 2) — pure transport. It knows nothing about accounts, symbols, or
 * orders. The session/adapter layer (Phase 3/4) calls `send(payloadType, payload)`
 * and subscribes to push events. Demo and live are isolated hosts, so there is one
 * socket per environment (matches cTrader's "≤2 connections per app" guidance).
 *
 * Endpoints (JSON serialization → port 5036):
 *   demo: wss://demo.ctraderapi.com:5036
 *   live: wss://live.ctraderapi.com:5036
 *
 * Verified against a live demo account: JSON envelope { clientMsgId, payloadType,
 * payload }, integer enums, app-auth 2100→2101, execution-event pushes 2126,
 * errors 2142 / order-errors 2132. Uses Node 22's built-in global WebSocket — no
 * dependency.
 */

import { EventEmitter } from 'node:events'
import { logger }       from '../services/logger.service.js'

const LOG = '[ctrader.ws]'

const HOSTS = {
    demo: 'wss://demo.ctraderapi.com:5036',
    live: 'wss://live.ctraderapi.com:5036',
}

// payloadTypes the transport itself needs to recognise. (Trading message types
// live in the session/adapter layer that calls send().)
const PT = {
    HEARTBEAT:         51,
    APP_AUTH_REQ:      2100,
    EXECUTION_EVENT:   2126,
    ORDER_ERROR_EVENT: 2132,
    ERROR_RES:         2142,
}

const HEARTBEAT_MS       = 10_000   // cTrader drops idle connections without this
const REQUEST_TIMEOUT_MS = 15_000
const RECONNECT_BASE_MS  = 1_000
const RECONNECT_MAX_MS   = 30_000

// One socket per environment, created lazily.
const _clients = new Map()  // 'demo' | 'live' → CTraderSocket

/**
 * Get the shared socket for an environment. Lazily created; call `.ready` (or any
 * `.send()`) to ensure it's connected and app-authenticated.
 * @param {boolean} isLive
 * @returns {CTraderSocket}
 */
export function getCTraderSocket(isLive = false) {
    const env = isLive ? 'live' : 'demo'
    if (!_clients.has(env)) _clients.set(env, new CTraderSocket(env))
    return _clients.get(env)
}

/**
 * Persistent ProtoOA JSON-over-WebSocket connection for one environment.
 *
 * Events:
 *   'authenticated' — emitted after every successful (re)connect + app-auth.
 *                     The session layer listens to re-account-auth + resubscribe.
 *   'execution'     — ProtoOAExecutionEvent (2126) push payload (fills, SL/TP, etc.)
 *   'push'          — any other unsolicited server message (full envelope)
 */
class CTraderSocket extends EventEmitter {
    constructor(env) {
        super()
        this.env     = env
        this.url     = HOSTS[env]
        this._ws     = null
        this._seq    = 0
        this._pending = new Map()   // clientMsgId → { resolve, reject, timer }
        this._hbTimer = null
        this._attempts = 0
        this._stopped  = false
        this._ready        = null
        this._resolveReady = null
        this._rejectReady  = null
    }

    /** Promise that resolves once connected + app-authenticated. Triggers connect. */
    get ready() {
        if (!this._ready) this.start()
        return this._ready
    }

    /** Idempotent connect. */
    start() {
        if (this._ws) return
        this._stopped = false
        this._connect()
    }

    /** Graceful shutdown — closes the socket and fails any in-flight requests. */
    stop() {
        this._stopped = true
        this._clearHeartbeat()
        this._failAllPending(new Error(`[${this.env}] socket stopped`))
        if (this._ws) { try { this._ws.close() } catch {} this._ws = null }
    }

    /**
     * Send a request and await its correlated response.
     * Waits for app-auth first, so callers never race the handshake.
     * @returns {Promise<object>} the response payload (rejects on 2132/2142/timeout)
     */
    async send(payloadType, payload = {}, opts = {}) {
        await this.ready
        return this._send(payloadType, payload, opts)
    }

    // ── internals ───────────────────────────────────────────────────────────────

    _connect() {
        this._ready = new Promise((resolve, reject) => {
            this._resolveReady = resolve
            this._rejectReady  = reject
        })
        // Don't let an unobserved rejection crash the process during reconnects.
        this._ready.catch(() => {})

        logger.info(LOG, `[${this.env}] connecting ${this.url}`)
        const ws = new WebSocket(this.url)
        this._ws = ws
        ws.addEventListener('open',    () => this._onOpen())
        ws.addEventListener('message', ev => this._onMessage(ev))
        ws.addEventListener('error',   ev => logger.error(LOG, `[${this.env}] ws error:`, ev?.message ?? 'unknown'))
        ws.addEventListener('close',   ev => this._onClose(ev))
    }

    async _onOpen() {
        logger.info(LOG, `[${this.env}] socket open — authenticating application`)
        try {
            // _send (not send) — app-auth must bypass the ready gate it resolves.
            await this._send(PT.APP_AUTH_REQ, {
                clientId:     process.env.CTRADER_CLIENTID,
                clientSecret: process.env.CTRADER_SECRET,
            })
            this._attempts = 0
            this._startHeartbeat()
            this._resolveReady()
            logger.info(LOG, `[${this.env}] application authenticated — ready`)
            this.emit('authenticated')
        } catch (err) {
            logger.error(LOG, `[${this.env}] app auth failed:`, err.message)
            this._rejectReady(err)
            try { this._ws?.close() } catch {}   // triggers _onClose → backoff reconnect
        }
    }

    _onMessage(ev) {
        const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
        let msg
        try { msg = JSON.parse(raw) } catch { logger.warn(LOG, `[${this.env}] non-JSON frame ignored`); return }

        if (msg.payloadType === PT.HEARTBEAT) return

        const pending = msg.clientMsgId && this._pending.get(msg.clientMsgId)
        if (pending) {
            clearTimeout(pending.timer)
            this._pending.delete(msg.clientMsgId)
            if (msg.payloadType === PT.ERROR_RES || msg.payloadType === PT.ORDER_ERROR_EVENT) {
                pending.reject(_protoError(msg))
            } else {
                pending.resolve(msg.payload ?? {})
            }
            return
        }

        // Unsolicited push — execution events (fills, server-side SL/TP) and anything else.
        if (msg.payloadType === PT.EXECUTION_EVENT) this.emit('execution', msg.payload ?? {})
        else this.emit('push', msg)
    }

    _onClose(ev) {
        logger.warn(LOG, `[${this.env}] socket closed: code=${ev?.code ?? '?'} reason=${ev?.reason ?? ''}`)
        this._clearHeartbeat()
        this._ws = null
        this._failAllPending(new Error(`[${this.env}] socket closed`))
        if (this._stopped) return

        const delay = Math.min(RECONNECT_BASE_MS * 2 ** this._attempts++, RECONNECT_MAX_MS)
        logger.info(LOG, `[${this.env}] reconnecting in ${delay}ms (attempt ${this._attempts})`)
        setTimeout(() => { if (!this._stopped) this._connect() }, delay)
    }

    _send(payloadType, payload, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error(`[${this.env}] socket not open`))
        }
        const clientMsgId = `c${++this._seq}`
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(clientMsgId)
                reject(new Error(`[${this.env}] timeout waiting for response to payloadType=${payloadType}`))
            }, timeoutMs)
            this._pending.set(clientMsgId, { resolve, reject, timer })
            try {
                this._ws.send(JSON.stringify({ clientMsgId, payloadType, payload }))
            } catch (err) {
                clearTimeout(timer)
                this._pending.delete(clientMsgId)
                reject(err)
            }
        })
    }

    _startHeartbeat() {
        this._clearHeartbeat()
        this._hbTimer = setInterval(() => {
            try { this._ws?.send(JSON.stringify({ payloadType: PT.HEARTBEAT, payload: {} })) } catch {}
        }, HEARTBEAT_MS)
    }

    _clearHeartbeat() {
        if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null }
    }

    _failAllPending(err) {
        for (const { reject, timer } of this._pending.values()) { clearTimeout(timer); reject(err) }
        this._pending.clear()
    }
}

function _protoError(msg) {
    const code = msg.payload?.errorCode ?? 'UNKNOWN'
    const desc = msg.payload?.description ?? ''
    const err  = new Error(`cTrader ${code}: ${desc}`)
    err.code = code
    return err
}
