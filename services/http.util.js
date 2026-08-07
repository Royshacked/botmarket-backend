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

export async function getJson(url, { headers, timeoutMs = 10000, label } = {}) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
        const res = await fetch(url, { headers, signal: ac.signal })
        if (!res.ok) {
            _count(label, res.status)
            // The status rides on the error, not just in its text. "Try again in a second"
            // (429, 5xx) and "your plan does not include this" (402, 403) are opposite
            // instructions, and a caller that can only read the message has to regex the
            // number back out to tell them apart — or, worse, treat them the same.
            const err = new Error(`${label || 'http'} ${res.status}`)
            err.status = res.status
            throw err
        }
        _count(label)
        return await res.json()
    } finally {
        clearTimeout(timer)
    }
}
