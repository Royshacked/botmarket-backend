import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.FMP_API_KEY ??= 'test-key'
const { getFmpCandles } = await import('../../providers/fmp.price.provider.js')

// Intraday candles are a PLAN feature, sliced by RESOLUTION. A refused interval answers 402
// "Restricted Endpoint" — the same answer for every symbol, every time, until the subscription
// changes — while the intervals the plan does cover keep working.
//
// Asking anyway is not a free miss. Each attempt spends a request against the same rate limit
// `/quote` needs, and `/quote` is the only real-time price the paper venue has. A mark loop over
// a dozen symbols every 3s burned its way into a 429 on the working endpoint — an outage we
// caused ourselves, on the one call that fills orders. Hence the latch.
//
// But the latch was once plan-WIDE, and that was measurably wrong on a real key: it serves 5min,
// 15min and 1hour and refuses only 1min, so the one 1-min request the paper venue makes on an open
// session pushed every other timeframe onto the fallback provider for half an hour. Every intraday
// read in the app degraded, silently, off the cheapest possible refusal.
//
// 429 must NOT latch either: that would turn a rate limit into a permanent loss of intraday data.

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

test('…and it is remembered ACROSS SYMBOLS: 1min never reaches the wire again', async () => {
    const calls = stubFetch(402)
    assert.equal(await getFmpCandles('ZTS',  { timeSpan: 'minute', multiplier: 1 }), null)
    assert.equal(await getFmpCandles('AAPL', { timeSpan: 'minute', multiplier: 1 }), null)
    assert.equal(calls.length, 0, 'a refused resolution is a property of the KEY, not of each symbol')
})

// The regression that mattered: 1min is refused on this plan, 5min/15min/1hour are not. A latch
// shared across resolutions turned one cheap refusal into a 30-minute intraday blackout.
test('a refused resolution does not silence the ones the plan DOES serve', async () => {
    const calls = stubFetch(200, [{ date: '2026-07-13 15:30:00', open: 77, high: 78, low: 76, close: 77.6, volume: 10 }])
    for (const [timeSpan, multiplier] of [['minute', 5], ['minute', 15], ['minute', 30], ['hour', 1], ['hour', 4]]) {
        const rows = await getFmpCandles('AAPL', { timeSpan, multiplier })
        assert.ok(rows?.length, `${timeSpan}x${multiplier} must still go to FMP after a 1min 402`)
    }
    assert.equal(calls.length, 5, 'every unrefused resolution still reaches the wire')
})

test('each resolution latches on its own 402, independently', async () => {
    stubFetch(402)
    assert.equal(await getFmpCandles('AAPL', { timeSpan: 'minute', multiplier: 30 }), null)

    // 30min is now latched too — but 5min, which never 402'd, is still live.
    const calls = stubFetch(200, [{ date: '2026-07-13 15:30:00', open: 1, high: 2, low: 1, close: 1.5, volume: 3 }])
    assert.equal(await getFmpCandles('AAPL', { timeSpan: 'minute', multiplier: 30 }), null)
    assert.ok((await getFmpCandles('AAPL', { timeSpan: 'minute', multiplier: 5 }))?.length)
    assert.equal(calls.length, 1, 'only the un-latched resolution went out')
})

test('daily bars are untouched — the plan restriction is intraday only', async () => {
    const calls = stubFetch(200, [{ date: '2026-07-13', open: 77, high: 78, low: 76, close: 77.6, volume: 10 }])
    const rows  = await getFmpCandles('ZTS', { timeSpan: 'day', multiplier: 1 })
    assert.equal(calls.length, 1, 'EOD still goes to FMP')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].close, 77.6)
})
