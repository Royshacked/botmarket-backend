import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.FMP_API_KEY ??= 'test-key'
const { getFmpCandles } = await import('../../providers/fmp.price.provider.js')

// Intraday candles are a PLAN feature. On a key without them every minute/hour request answers
// 402 "Restricted Endpoint" — the same answer for every symbol, every time, until the
// subscription changes.
//
// Asking anyway is not a free miss. Each attempt spends a request against the same rate limit
// `/quote` needs, and `/quote` is the only real-time price the paper venue has. A mark loop over
// a dozen symbols every 3s burned its way into a 429 on the working endpoint — an outage we
// caused ourselves, on the one call that fills orders. Hence the latch.
//
// 429 must NOT latch: that would turn a rate limit into a permanent loss of intraday data.

/** Stub global fetch with a fixed status, counting calls. */
function stubFetch(status, body = []) {
    const calls = []
    globalThis.fetch = async (url) => {
        calls.push(String(url))
        return {
            ok:     status >= 200 && status < 300,
            status,
            json:   async () => body,
            text:   async () => JSON.stringify(body),
        }
    }
    return calls
}

const realFetch = globalThis.fetch
test.after(() => { globalThis.fetch = realFetch })

// ORDER MATTERS: the latch is module-level, so everything that must see an un-latched provider
// has to run before the test that trips it.

test('a 429 on intraday rethrows — a rate limit is not a plan verdict', async () => {
    stubFetch(429)
    await assert.rejects(
        () => getFmpCandles('ZTS', { timeSpan: 'minute', multiplier: 1 }),
        /429/,
        'the router catches this and falls back for THIS call only',
    )
    // And it did not latch: the next intraday call still goes out to the wire.
    const calls = stubFetch(429)
    await assert.rejects(() => getFmpCandles('ZTS', { timeSpan: 'minute', multiplier: 1 }))
    assert.equal(calls.length, 1, 'a transient failure must not suppress future intraday requests')
})

test('a 402 returns null so the router falls through to the fallback provider', async () => {
    stubFetch(402)
    // null, not [] — null is what candles.provider reads as "FMP shouldn't serve this".
    assert.equal(await getFmpCandles('ZTS', { timeSpan: 'minute', multiplier: 1 }), null)
})

test('…and it is remembered: no further intraday request reaches the wire', async () => {
    const calls = stubFetch(402)
    assert.equal(await getFmpCandles('ZTS',  { timeSpan: 'minute', multiplier: 1 }), null)
    assert.equal(await getFmpCandles('AAPL', { timeSpan: 'minute', multiplier: 5 }), null)
    assert.equal(await getFmpCandles('MSFT', { timeSpan: 'hour',   multiplier: 1 }), null)
    assert.equal(calls.length, 0, 'the plan is a property of the KEY, not of each symbol')
})

test('daily bars are untouched — the plan restriction is intraday only', async () => {
    const calls = stubFetch(200, [{ date: '2026-07-13', open: 77, high: 78, low: 76, close: 77.6, volume: 10 }])
    const rows  = await getFmpCandles('ZTS', { timeSpan: 'day', multiplier: 1 })
    assert.equal(calls.length, 1, 'EOD still goes to FMP')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].close, 77.6)
})
