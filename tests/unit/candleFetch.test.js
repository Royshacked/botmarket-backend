import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toMsCandles, fetchMarketCandles, buildFormingBar } from '../../services/candleFetch.service.js'
import { fmpDateToEpochSec } from '../../providers/fmp.price.provider.js'

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

// ── fetchMarketCandles: ONE source call, then ms + the forming bar ──────────────
//
// WHICH provider serves a spec is candles.provider's decision, not this module's — see
// candlesProvider.test.js. This module used to make the same decision a second time on top of the
// router, which cost a duplicate FMP request on every fallback; what is asserted here now is that
// it asks the router ONCE and adds only what it owns.
const SPEC = { timeSpan: 'day', multiplier: 1, from: 1, to: 2 }
const CANDLE = { timestamp: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }

test('asks the source router exactly once, and converts sec→ms', async () => {
    let calls = 0
    const out = await fetchMarketCandles('aapl', SPEC, {
        getTickerAggregates: async () => { calls++; return [CANDLE] },
    })
    assert.equal(calls, 1, 'the router owns the FMP-vs-Massive choice — asking twice is the bug this closes')
    assert.equal(out.length, 1)
    assert.equal(out[0].timestamp, 1_700_000_000_000)
})

test('an empty answer from the router is an empty chart, not a second attempt', async () => {
    for (const empty of [null, [], undefined]) {
        let calls = 0
        const out = await fetchMarketCandles('aapl', SPEC, {
            getTickerAggregates: async () => { calls++; return empty },
        })
        assert.deepEqual(out, [], `empty=${JSON.stringify(empty)}`)
        assert.equal(calls, 1)
    }
})

test('returns [] for an empty symbol without calling the router', async () => {
    let called = false
    const out = await fetchMarketCandles('   ', SPEC, {
        getTickerAggregates: async () => { called = true; return [CANDLE] },
    })
    assert.deepEqual(out, [])
    assert.equal(called, false)
})

test('uppercases the symbol before fetching', async () => {
    let seen = null
    await fetchMarketCandles('aapl', SPEC, { getTickerAggregates: async (sym) => { seen = sym; return [CANDLE] } })
    assert.equal(seen, 'AAPL')
})

// ── buildFormingBar: the day the EOD feed has not published yet ────────────────
// FMP publishes the running day's row LATE — measured absent 90 minutes into the session and
// present some hours later — so early in a session the newest daily bar is the previous trading
// day's. The chart then paints the live price onto that bar, which is how a Friday candle came to
// render with Monday's close. These pin the gate that decides when today's bar is real, because
// every one of them is a way to invent a candle that never traded.

// Real numbers, taken off the wire on Mon 2026-08-17 with AVGO's daily series ending Friday.
const FRI = fmpDateToEpochSec('2026-08-14') * 1000
const FRI_BAR = { timestamp: FRI, open: 411.96, high: 412.5, low: 388.5, close: 392.99, volume: 29_513_597 }
const MON_QUOTE = { price: 397.48, open: 397.08, dayHigh: 398.15, dayLow: 392.05, volume: 8_384_828, tsSec: 1_786_978_766 }
const DAILY = { timeSpan: 'day', multiplier: 1 }

test('forming bar: a live quote a day past the newest bar becomes today\'s candle', () => {
    const bar = buildFormingBar(FRI_BAR, DAILY, MON_QUOTE)
    assert.ok(bar, 'Monday mid-session must produce Monday\'s bar')
    assert.equal(bar.timestamp, fmpDateToEpochSec('2026-08-17') * 1000, 'stamped at ET midnight, like every other daily bar')
    assert.deepEqual(
        { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume },
        { open: 397.08, high: 398.15, low: 392.05, close: 397.48, volume: 8_384_828 },
        'the session so far, not a copy of the last close',
    )
})

test('forming bar: the WEEKEND invents nothing — the quote still reads Friday', () => {
    // THE gate. On Saturday the quote is Friday's last print, which files under Friday's period —
    // the same period as the last bar. No clock, no session table: the trade time decides.
    const satMorning = { ...MON_QUOTE, price: 392.99, tsSec: Math.floor(FRI / 1000) + 8 * 3600 }
    assert.equal(buildFormingBar(FRI_BAR, DAILY, satMorning), null)
})

test('forming bar: a feed that already carries today is left alone', () => {
    // Yahoo's daily feed does include the running day. Same test catches it: same period, no bar.
    const todayBar = { ...FRI_BAR, timestamp: fmpDateToEpochSec('2026-08-17') * 1000 }
    assert.equal(buildFormingBar(todayBar, DAILY, MON_QUOTE), null)
})

test('forming bar: a period is only opened once — week yes, month not yet', () => {
    // Monday opens a new WEEK, so the weekly series has nothing for it: build it, stamped at today's
    // ET midnight (groupOhlcByPeriod stamps a period at its FIRST day, which today necessarily is).
    assert.equal(
        buildFormingBar(FRI_BAR, { timeSpan: 'week', multiplier: 1 }, MON_QUOTE)?.timestamp,
        fmpDateToEpochSec('2026-08-17') * 1000,
    )
    // The same Monday opens no new MONTH — August's bar already exists, built from the 1st to the
    // 14th. Appending here would put two August candles on the chart; the live patch updates the
    // one that is there. The gate is the PERIOD, which is why one rule covers all three spans.
    assert.equal(buildFormingBar(FRI_BAR, { timeSpan: 'month', multiplier: 1 }, MON_QUOTE), null)
    // …and when the last monthly bar really is a month behind, it builds.
    const july = { ...FRI_BAR, timestamp: fmpDateToEpochSec('2026-07-01') * 1000 }
    assert.equal(
        buildFormingBar(july, { timeSpan: 'month', multiplier: 1 }, MON_QUOTE)?.timestamp,
        fmpDateToEpochSec('2026-08-17') * 1000,
    )
})

test('forming bar: only the un-aggregated EOD spans', () => {
    // An aggregate's groups are counted off the end of the series; a lone extra bar shifts every
    // boundary behind it.
    assert.equal(buildFormingBar(FRI_BAR, { timeSpan: 'day', multiplier: 2 }, MON_QUOTE), null)
    // Intraday feeds publish their own forming bar — adding a second one would duplicate it.
    assert.equal(buildFormingBar(FRI_BAR, { timeSpan: 'minute', multiplier: 5 }, MON_QUOTE), null)
})

test('forming bar: no history means an uncovered symbol, not a gap to fill', () => {
    assert.equal(buildFormingBar(null, DAILY, MON_QUOTE), null)
    assert.equal(buildFormingBar(undefined, DAILY, MON_QUOTE), null)
    assert.equal(buildFormingBar({}, DAILY, MON_QUOTE), null)
})

test('forming bar: an unusable quote is never turned into a candle', () => {
    for (const q of [null, {}, { price: 0, tsSec: 1_786_978_766 }, { price: 397, tsSec: null }]) {
        assert.equal(buildFormingBar(FRI_BAR, DAILY, q), null, JSON.stringify(q))
    }
})

test('forming bar: a degenerate quote still yields a coherent candle', () => {
    // normalizeFmpQuote defaults dayHigh/dayLow to price; with an open above both, a naive
    // high/low would cut through the body.
    const q = { price: 100, open: 105, dayHigh: 100, dayLow: 100, tsSec: 1_786_978_766 }
    const bar = buildFormingBar(FRI_BAR, DAILY, q)
    assert.equal(bar.high, 105)
    assert.equal(bar.low, 100)
    assert.ok(bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close))
})

test('forming bar: a historical window must not gain a bar dated today', () => {
    // A quote is always "now". Scrolling back through April cannot grow an August candle.
    assert.equal(buildFormingBar(FRI_BAR, DAILY, MON_QUOTE, { toMs: FRI + 3_600_000 }), null)
})

test('fetchMarketCandles: appends the forming bar, and a quote failure keeps the history', async () => {
    const deps = {
        getTickerAggregates: async () => [{ ...FRI_BAR, timestamp: FRI / 1000 }],   // provider emits seconds
    }
    const withBar = await fetchMarketCandles('avgo', { timeSpan: 'day', multiplier: 1 }, {
        ...deps, getFmpQuoteFull: async () => MON_QUOTE,
    })
    assert.equal(withBar.length, 2)
    assert.equal(withBar[1].close, 397.48)

    // The whole point of the try/catch: today's bar is a nicety, the history is the chart.
    const quoteDown = await fetchMarketCandles('avgo', { timeSpan: 'day', multiplier: 1 }, {
        ...deps, getFmpQuoteFull: async () => { throw new Error('FMP 429') },
    })
    assert.equal(quoteDown.length, 1)
})
