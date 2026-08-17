import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtVol, aggregateCandles, CANDLE_CFG, _withFormingBar } from '../../services/tools/marketData.tools.js'
import { fmpDateToEpochSec } from '../../providers/fmp.price.provider.js'

// ── fmtVol ───────────────────────────────────────────────────────────────
test('fmtVol: millions get one decimal + M', () => {
    assert.equal(fmtVol(1_500_000), '1.5M')
    assert.equal(fmtVol(12_000_000), '12.0M')
})
test('fmtVol: thousands round to K', () => {
    assert.equal(fmtVol(1_000), '1K')
    assert.equal(fmtVol(12_500), '13K')
})
test('fmtVol: sub-1000 pass through as string', () => {
    assert.equal(fmtVol(0), '0')
    assert.equal(fmtVol(999), '999')
})

// ── aggregateCandles ─────────────────────────────────────────────────────
const bar = (t, o, h, l, c, v) => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: v })

test('aggregateCandles: groups N→1 with correct OHLCV', () => {
    const rows = [bar(1, 10, 15, 8, 12, 100), bar(2, 12, 20, 11, 18, 200)]
    assert.deepEqual(aggregateCandles(rows, 2), [
        { timestamp: 1, open: 10, high: 20, low: 8, close: 18, volume: 300 },
    ])
})

test('aggregateCandles: drops the oldest partial group (aligns to newest)', () => {
    // 3 rows, group of 2 → the oldest single row is dropped; one clean pair remains.
    const rows = [bar(1, 1, 1, 1, 1, 5), bar(2, 2, 9, 0, 3, 10), bar(3, 3, 8, 2, 4, 20)]
    const out = aggregateCandles(rows, 2)
    assert.equal(out.length, 1)
    assert.deepEqual(out[0], { timestamp: 2, open: 2, high: 9, low: 0, close: 4, volume: 30 })
})

test('aggregateCandles: empty / non-array → []', () => {
    assert.deepEqual(aggregateCandles([], 2), [])
    assert.deepEqual(aggregateCandles(null, 2), [])
})

test('aggregateCandles: missing volume counts as 0', () => {
    const rows = [{ timestamp: 1, open: 1, high: 2, low: 0, close: 1 }, bar(2, 1, 3, 0, 2, 7)]
    assert.equal(aggregateCandles(rows, 2)[0].volume, 7)
})

// ── CANDLE_CFG ───────────────────────────────────────────────────────────
test('CANDLE_CFG: only 2hr/4hr aggregate, from native 1hr bars', () => {
    assert.equal(CANDLE_CFG['2hr'].aggregate, 2)
    assert.equal(CANDLE_CFG['4hr'].aggregate, 4)
    assert.equal(CANDLE_CFG['2hr'].timeSpan, 'hour')
    for (const tf of ['1min', '5min', '1hr', 'day', 'week', 'month']) {
        assert.equal(CANDLE_CFG[tf].aggregate, undefined, `${tf} should not aggregate`)
    }
})

// ── _withFormingBar: the agent reads the same session the chart draws ──────────
// The EOD feed publishes a day only after it closes, so an agent asking for daily candles
// mid-session used to get a series ending yesterday while the chart IMAGE beside it already showed
// today. This path's own hazard is UNITS: it works in provider seconds, buildFormingBar in ms.

const SEC = (dateStr) => fmpDateToEpochSec(dateStr)
const FRI_ROW = { timestamp: SEC('2026-08-14'), open: 411.96, high: 412.5, low: 388.5, close: 392.99, volume: 29_513_597 }
const MON_QUOTE = { price: 397.48, open: 397.08, dayHigh: 398.15, dayLow: 392.05, volume: 8_384_828, tsSec: 1_786_978_766 }

test('_withFormingBar: appends today in SECONDS, the unit this path speaks', async () => {
    const out = await _withFormingBar('AVGO', CANDLE_CFG['day'], Date.now(), [FRI_ROW],
        { getFmpQuoteFull: async () => MON_QUOTE })
    assert.equal(out.length, 2)
    assert.equal(out[1].timestamp, SEC('2026-08-17'), 'seconds — an ms stamp here would sort to the year 58000')
    assert.equal(out[1].close, 397.48)
    assert.equal(out[0].close, 392.99, 'Friday keeps its real close')
})

test('_withFormingBar: an hourly timeframe is left alone (its feed carries the forming bar)', async () => {
    const rows = [{ ...FRI_ROW, timestamp: SEC('2026-08-14') + 3600 }]
    const out  = await _withFormingBar('AVGO', CANDLE_CFG['1hr'], Date.now(), rows,
        { getFmpQuoteFull: async () => MON_QUOTE })
    assert.equal(out.length, 1)
})

test('_withFormingBar: a quote failure or an empty series returns the rows untouched', async () => {
    const thrown = await _withFormingBar('AVGO', CANDLE_CFG['day'], Date.now(), [FRI_ROW],
        { getFmpQuoteFull: async () => { throw new Error('FMP 429') } })
    assert.deepEqual(thrown, [FRI_ROW])

    for (const empty of [[], null]) {
        assert.deepEqual(await _withFormingBar('AVGO', CANDLE_CFG['day'], Date.now(), empty,
            { getFmpQuoteFull: async () => MON_QUOTE }), [])
    }
})
