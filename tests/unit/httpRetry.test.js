import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getJson, isRetryableStatus, parseRetryAfterMs, _retryDelayMs } from '../../services/http.util.js'

// A 429 is a fact about the last sixty seconds, not about the request — and ours are self-inflicted
// bursts, so the next second is usually clear. What must NOT happen is re-asking a server that
// already gave its final answer (402 "not on your plan"), or waiting an hour because it said so.

// ── isRetryableStatus ────────────────────────────────────────────────────────
test('429 and 5xx are transient; the 4xx that state a fact are not', () => {
    for (const s of [429, 500, 502, 503, 599]) assert.equal(isRetryableStatus(s), true, String(s))
    for (const s of [400, 401, 402, 403, 404, 422, 600]) assert.equal(isRetryableStatus(s), false, String(s))
})

// ── parseRetryAfterMs ────────────────────────────────────────────────────────
test('delta-seconds form', () => {
    assert.equal(parseRetryAfterMs('2'), 2000)
    assert.equal(parseRetryAfterMs('0'), 0)
    assert.equal(parseRetryAfterMs('-5'), 0)   // never negative
})

test('HTTP-date form is measured against the given now', () => {
    const now = Date.parse('2026-08-12T23:18:00Z')
    assert.equal(parseRetryAfterMs('Wed, 12 Aug 2026 23:18:03 GMT', now), 3000)
    assert.equal(parseRetryAfterMs('Wed, 12 Aug 2026 23:17:00 GMT', now), 0)   // already past
})

test('absent or unparseable → null (fall back to our own backoff)', () => {
    for (const bad of [null, undefined, '', 'soon', 'NaN']) assert.equal(parseRetryAfterMs(bad), null, String(bad))
})

// ── _retryDelayMs ────────────────────────────────────────────────────────────
test('the server’s own answer wins, but is clamped so it cannot wedge the request', () => {
    assert.equal(_retryDelayMs(0, 1500, 300, () => 1), 1500)
    assert.equal(_retryDelayMs(0, 3_600_000, 300, () => 1), 2000)   // "sleep an hour" → 2s + fallback
})

test('without a header: exponential, fully jittered', () => {
    assert.equal(_retryDelayMs(0, null, 300, () => 1), 300)     // attempt 0 → up to base
    assert.equal(_retryDelayMs(1, null, 300, () => 1), 600)     // attempt 1 → up to 2× base
    assert.equal(_retryDelayMs(0, null, 300, () => 0), 0)       // jitter reaches the floor
    assert.equal(_retryDelayMs(9, null, 300, () => 1), 2000)    // and the ceiling holds
})

// ── getJson: the loop ────────────────────────────────────────────────────────
const realFetch = globalThis.fetch
let calls = []

const reply = (status, body = [{ ok: true }], headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    json: async () => body,
})

/** Queue one reply per call; the last one repeats. */
function stubFetch(...replies) {
    globalThis.fetch = async (url) => {
        calls.push(url)
        return replies[Math.min(calls.length - 1, replies.length - 1)]
    }
}

beforeEach(() => { calls = [] })
afterEach(() => { globalThis.fetch = realFetch })

// retryBaseMs: 0 keeps the suite offline AND instant — the jitter multiplies to 0.
const FAST = { retryBaseMs: 0, label: 'TEST /x' }

test('a 429 that clears on the retry returns the body — the caller never sees the blip', async () => {
    stubFetch(reply(429), reply(200, [{ price: 7 }]))
    const out = await getJson('https://x/y', FAST)
    assert.deepEqual(out, [{ price: 7 }])
    assert.equal(calls.length, 2)
})

test('retries are bounded — a persistent 429 throws with the status attached', async () => {
    stubFetch(reply(429))
    await assert.rejects(() => getJson('https://x/y', { ...FAST, retries: 2 }), err => {
        assert.equal(err.status, 429)
        assert.match(err.message, /TEST \/x 429/)
        return true
    })
    assert.equal(calls.length, 3, 'retries: 2 means 3 attempts, never more')
})

test('402 is the plan speaking — asked exactly once', async () => {
    stubFetch(reply(402))
    await assert.rejects(() => getJson('https://x/y', FAST), err => err.status === 402)
    assert.equal(calls.length, 1)
})

test('retries: 0 opts a polling caller out entirely', async () => {
    stubFetch(reply(429))
    await assert.rejects(() => getJson('https://x/y', { ...FAST, retries: 0 }), err => err.status === 429)
    assert.equal(calls.length, 1)
})

test('5xx retries too, and a success on the last allowed attempt still counts', async () => {
    stubFetch(reply(503), reply(503), reply(200, [{ v: 1 }]))
    const out = await getJson('https://x/y', { ...FAST, retries: 2 })
    assert.deepEqual(out, [{ v: 1 }])
    assert.equal(calls.length, 3)
})

test('a first-try success costs exactly one request', async () => {
    stubFetch(reply(200, [{ v: 1 }]))
    assert.deepEqual(await getJson('https://x/y', FAST), [{ v: 1 }])
    assert.equal(calls.length, 1)
})

test('a Retry-After header is honoured (clamped) rather than ignored', async () => {
    stubFetch(reply(429, [], { 'retry-after': '0' }), reply(200, [{ v: 1 }]))
    const out = await getJson('https://x/y', { label: 'TEST /x' })   // no retryBaseMs: the header drives it
    assert.deepEqual(out, [{ v: 1 }])
    assert.equal(calls.length, 2)
})
