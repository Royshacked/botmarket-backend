import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toMsCandles, fetchMarketCandles } from '../../services/candleFetch.service.js'

// Providers emit epoch SECONDS; every candle consumer (KLineCharts + the headless renderer) wants
// milliseconds. toMsCandles is the one guarded converter — it must scale seconds up, leave
// already-ms values untouched, and default a missing volume to 0.

test('scales second timestamps to milliseconds', () => {
    const out = toMsCandles([{ timestamp: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }])
    assert.equal(out[0].timestamp, 1_700_000_000_000)
})

test('leaves millisecond timestamps untouched', () => {
    const ms = 1_700_000_000_000
    const out = toMsCandles([{ timestamp: ms, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }])
    assert.equal(out[0].timestamp, ms)
})

test('defaults missing volume to 0 and preserves OHLC', () => {
    const out = toMsCandles([{ timestamp: 1_700_000_000, open: 10, high: 12, low: 9, close: 11 }])
    assert.deepEqual(out[0], { timestamp: 1_700_000_000_000, open: 10, high: 12, low: 9, close: 11, volume: 0 })
})

test('non-array input yields empty array (no throw)', () => {
    assert.deepEqual(toMsCandles(null), [])
    assert.deepEqual(toMsCandles(undefined), [])
    assert.deepEqual(toMsCandles('nope'), [])
})

test('the 1e12 boundary treats a large second value as seconds', () => {
    // 1e12 - 1 is < 1e12 → treated as seconds and scaled; exactly 1e12 → already ms.
    assert.equal(toMsCandles([{ timestamp: 1e12 - 1 }])[0].timestamp, (1e12 - 1) * 1000)
    assert.equal(toMsCandles([{ timestamp: 1e12 }])[0].timestamp, 1e12)
})

// ── fetchMarketCandles: FMP-first → router fallback (the module's actual value) ──
const SPEC = { timeSpan: 'day', multiplier: 1, from: 1, to: 2 }
const CANDLE = { timestamp: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }

test('uses FMP result when FMP returns candles (router not called)', async () => {
    let routerCalled = false
    const out = await fetchMarketCandles('aapl', SPEC, {
        getFmpCandles:       async () => [CANDLE],
        getTickerAggregates: async () => { routerCalled = true; return [] },
    })
    assert.equal(routerCalled, false)
    assert.equal(out.length, 1)
    assert.equal(out[0].timestamp, 1_700_000_000_000)   // sec→ms applied
})

test('falls back to the router when FMP THROWS', async () => {
    const out = await fetchMarketCandles('aapl', SPEC, {
        getFmpCandles:       async () => { throw new Error('FMP 500') },
        getTickerAggregates: async () => [CANDLE],
    })
    assert.equal(out.length, 1)
    assert.equal(out[0].close, 1.5)
})

test('falls back to the router when FMP returns null or []', async () => {
    for (const empty of [null, []]) {
        const out = await fetchMarketCandles('aapl', SPEC, {
            getFmpCandles:       async () => empty,
            getTickerAggregates: async () => [CANDLE],
        })
        assert.equal(out.length, 1, `empty=${JSON.stringify(empty)}`)
    }
})

test('returns [] for an empty symbol without calling providers', async () => {
    let called = false
    const out = await fetchMarketCandles('   ', SPEC, {
        getFmpCandles:       async () => { called = true; return [CANDLE] },
        getTickerAggregates: async () => { called = true; return [CANDLE] },
    })
    assert.deepEqual(out, [])
    assert.equal(called, false)
})

test('uppercases the symbol before fetching', async () => {
    let seen = null
    await fetchMarketCandles('aapl', SPEC, {
        getFmpCandles:       async (sym) => { seen = sym; return [CANDLE] },
        getTickerAggregates: async () => [],
    })
    assert.equal(seen, 'AAPL')
})
