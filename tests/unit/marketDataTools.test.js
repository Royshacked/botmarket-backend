import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtVol, aggregateCandles, CANDLE_CFG } from '../../services/marketData.tools.js'

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
