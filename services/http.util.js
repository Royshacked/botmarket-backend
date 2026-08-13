// Shared JSON-over-HTTP helper: fetch with an AbortController timeout and a
// status check. Transport only — callers keep their own try/catch and decide
// whether to swallow the error (return a string/empty) or rethrow.

import { logger } from './logger.service.js'
import { config } from './config.js'

const LOG = '[http.meter]'

// ── Request meter ─────────────────────────────────────────────────────────────
// Third-party quotas are per MINUTE, and the biggest consumer of ours is our own polling: the
// paper mark and fill loops run every 3s and price every open symbol, so the bill scales with how
// much the user is holding, not with what they are doing. When that tips over, the provider starts
// answering 429 — and it lands on whatever asks next, which is usually an agent mid-reply rather
// than the loop that actually spent the quota. The symptom is nowhere near the cause.
//
// So every request is counted where they all pass through, and a one-line summary goes out once a
// minute. Grouped by ENDPOINT, not by symbol: "which call is spending it" is the actionable
// question, and one line per ticker would be the noise this exists to replace.
//
// Set HTTP_METER_MS=0 to switch it off.
const METER_MS = config.httpMeterMs

const _counts = new Map()   // endpoint key → count
const _errors = new Map()   // status → count
let _meterTimer = null

/**
 * Endpoint identity for a request label, with the symbol stripped. Pure; exported for tests.
 *
 *   'FMP /quote AAPL'              → 'FMP /quote'
 *   'FMP candles AAPL/minutex5'    → 'FMP candles minutex5'
 *
 * The timeframe is KEPT while the ticker is dropped: 200 candle requests is not a finding, but
 * "190 of them were 1-minute bars this plan refuses" is.
 */
export function _meterKey(label = 'http') {
    const [a, b, rest] = String(label || 'http').split(' ')
    const head = [a, b].filter(Boolean).join(' ')
    if (!rest) return head
    const slash = rest.indexOf('/')
    return slash >= 0 ? `${head} ${rest.slice(slash + 1)}` : head
}

function _flush() {
    if (!_counts.size && !_errors.size) return
    const total = [..._counts.values()].reduce((a, b) => a + b, 0)
    const by    = [..._counts.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k}=${n}`).join(' ')
    const errs  = [..._errors.entries()].sort((x, y) => y[1] - x[1]).map(([s, n]) => `${s}×${n}`).join(' ')
    logger.info(LOG, `${total} req/min · ${by}${errs ? ` · errors ${errs}` : ''}`)
    _counts.clear()
    _errors.clear()
}

function _count(label, status = null) {
    if (!METER_MS) return
    const key = _meterKey(label)
    _counts.set(key, (_counts.get(key) ?? 0) + 1)
    if (status) _errors.set(status, (_errors.get(status) ?? 0) + 1)
    // Armed on the first request rather than at import: a process that makes no HTTP calls (a test
    // run, a script) should not be left holding a timer. unref'd for the same reason — the meter
    // must never be the thing keeping the process alive.
    if (!_meterTimer) {
        _meterTimer = setInterval(_flush, METER_MS)
        _meterTimer.unref?.()
    }
}

// ── Retry ─────────────────────────────────────────────────────────────────────
// A 429 is not a fact about the request, it is a fact about the last sixty seconds — and ours are
// self-inflicted bursts (see the meter above), so the next second is usually clear. Un-retried, that
// blip surfaces as real damage: the FMP candle call falls through to Massive, an agent's tool loop
// reports a failure to the user, a chart draws from the fallback provider instead of the one the
// monitor evaluates against. One retry turns almost all of it into ~300ms of latency nobody sees.
//
// WHAT IS RETRIED: 429 and 5xx only. Everything else is the server stating something that will not
// change by asking again — 402 "not on your plan", 403, 404, 401 — and re-asking spends quota to
// receive the same answer. Network errors and our own timeout are deliberately NOT retried either:
// both already cost the caller its full budget, and every provider that can fall back does so on
// the throw. Retrying a host that is down just makes the failure three times slower.
//
// The delay respects `Retry-After` when the server sends one (it knows its own window) and is
// otherwise exponential with FULL JITTER. The jitter is load-bearing, not decoration: the mark loop
// prices every open symbol in one burst, so a fixed backoff would re-collide all of them on the
// same tick and re-trigger the limit that caused the retry.
const RETRIES       = config.httpRetries
const RETRY_BASE_MS = config.httpRetryBaseMs
const RETRY_MAX_MS  = 2_000   // ceiling for one wait, incl. a server-sent Retry-After

/** Transient by status: worth asking again. Pure; exported for tests. */
export function isRetryableStatus(status) {
    return status === 429 || (status >= 500 && status <= 599)
}

/**
 * `Retry-After` → ms, or null when absent/unparseable. Accepts both legal forms: delta-seconds
 * ("2") and an HTTP date ("Wed, 12 Aug 2026 23:18:07 GMT"). Never negative. Pure; exported for tests.
 *
 * @param {string|null|undefined} header
 * @param {number} nowMs  reference time for the date form (injectable so the test is not clock-bound)
 */
export function parseRetryAfterMs(header, nowMs = Date.now()) {
    if (header == null || header === '') return null
    const secs = Number(header)
    if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : 0
    const at = Date.parse(header)
    if (!Number.isFinite(at)) return null
    return Math.max(0, at - nowMs)
}

/**
 * How long to wait before attempt N+1: the server's own answer when it gave one, else exponential
 * full jitter (`random() * base * 2^attempt`). Clamped to RETRY_MAX_MS either way, so a provider
 * asking us to sleep for an hour costs us 2s and a fallback rather than a wedged request.
 * Pure apart from the jitter; exported for tests (`rand` is the seam).
 */
export function _retryDelayMs(attempt, retryAfterMs, baseMs = RETRY_BASE_MS, rand = Math.random) {
    if (retryAfterMs != null) return Math.min(retryAfterMs, RETRY_MAX_MS)
    return Math.min(Math.round(rand() * baseMs * 2 ** attempt), RETRY_MAX_MS)
}

const _sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * JSON over HTTP with a per-attempt timeout, the request meter, and a bounded retry on transient
 * failures.
 *
 * @param {string} url
 * @param {{ headers?: object, timeoutMs?: number, label?: string, retries?: number, retryBaseMs?: number }} [opts]
 *   `timeoutMs` bounds EACH attempt, not the total — a retry gets a full budget or it isn't one.
 *   `retries: 0` opts a caller out (polling loops: the next tick is already the retry).
 */
export async function getJson(url, { headers, timeoutMs = 10000, label, retries = RETRIES, retryBaseMs = RETRY_BASE_MS } = {}) {
    const attempts = Math.max(0, retries) + 1
    for (let attempt = 0; ; attempt++) {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), timeoutMs)
        let res
        try {
            res = await fetch(url, { headers, signal: ac.signal })
        } finally {
            clearTimeout(timer)
        }

        if (res.ok) {
            _count(label)
            return await res.json()
        }

        // Counted per ATTEMPT — each one really did spend a request against the quota, and a meter
        // that hid the retries would understate exactly the pressure it exists to expose.
        _count(label, res.status)
        // The status rides on the error, not just in its text. "Try again in a second"
        // (429, 5xx) and "your plan does not include this" (402, 403) are opposite
        // instructions, and a caller that can only read the message has to regex the
        // number back out to tell them apart — or, worse, treat them the same.
        const err = new Error(`${label || 'http'} ${res.status}`)
        err.status = res.status
        if (attempt >= attempts - 1 || !isRetryableStatus(res.status)) throw err

        const wait = _retryDelayMs(attempt, parseRetryAfterMs(res.headers?.get?.('retry-after')), retryBaseMs)
        logger.info(LOG, `${label || 'http'} ${res.status} — retrying in ${wait}ms (attempt ${attempt + 2}/${attempts})`)
        await _sleep(wait)
    }
}
