import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseChartInterval, defaultLookbackDays } from '../../services/candleInterval.util.js'

// Phase 1 (klinecharts): the chart route maps interval spellings → { timeSpan, multiplier }
// the candle providers speak. Every spelling the frontend may send must resolve, and the
// TradingView-code overlap (M = month, D = day) must NOT collide with the minute codes.

// ── app words ────────────────────────────────────────────────────────────────
test('minute spellings', () => {
    assert.deepEqual(parseChartInterval('1min'),  { timeSpan: 'minute', multiplier: 1 })
    assert.deepEqual(parseChartInterval('5min'),  { timeSpan: 'minute', multiplier: 5 })
    assert.deepEqual(parseChartInterval('15min'), { timeSpan: 'minute', multiplier: 15 })
    assert.deepEqual(parseChartInterval('30min'), { timeSpan: 'minute', multiplier: 30 })
})

test('hour spellings incl. 2hr aggregation spec', () => {
    assert.deepEqual(parseChartInterval('1hr'),   { timeSpan: 'hour', multiplier: 1 })
    assert.deepEqual(parseChartInterval('2hr'),   { timeSpan: 'hour', multiplier: 2 })
    assert.deepEqual(parseChartInterval('4hour'), { timeSpan: 'hour', multiplier: 4 })
})

test('day / week / month app words', () => {
    assert.deepEqual(parseChartInterval('day'),   { timeSpan: 'day',   multiplier: 1 })
    assert.deepEqual(parseChartInterval('week'),  { timeSpan: 'week',  multiplier: 1 })
    assert.deepEqual(parseChartInterval('month'), { timeSpan: 'month', multiplier: 1 })
})

// ── TradingView codes (from the old embed) ───────────────────────────────────
test('TV numeric minute/hour codes', () => {
    assert.deepEqual(parseChartInterval('1'),   { timeSpan: 'minute', multiplier: 1 })
    assert.deepEqual(parseChartInterval('5'),   { timeSpan: 'minute', multiplier: 5 })
    assert.deepEqual(parseChartInterval('60'),  { timeSpan: 'hour',   multiplier: 1 })
    assert.deepEqual(parseChartInterval('240'), { timeSpan: 'hour',   multiplier: 4 })
})

test('TV letter codes: D=day, W=week, M=month (M is NOT minute)', () => {
    assert.deepEqual(parseChartInterval('D'), { timeSpan: 'day',   multiplier: 1 })
    assert.deepEqual(parseChartInterval('W'), { timeSpan: 'week',  multiplier: 1 })
    assert.deepEqual(parseChartInterval('M'), { timeSpan: 'month', multiplier: 1 })
})

// ── legacy + normalisation ───────────────────────────────────────────────────
test('legacy daily/weekly/monthly', () => {
    assert.deepEqual(parseChartInterval('daily'),   { timeSpan: 'day',   multiplier: 1 })
    assert.deepEqual(parseChartInterval('weekly'),  { timeSpan: 'week',  multiplier: 1 })
    assert.deepEqual(parseChartInterval('monthly'), { timeSpan: 'month', multiplier: 1 })
})

test('case-insensitive + trims whitespace', () => {
    assert.deepEqual(parseChartInterval('  5MIN '), { timeSpan: 'minute', multiplier: 5 })
    assert.deepEqual(parseChartInterval('d'),       { timeSpan: 'day', multiplier: 1 })
})

test('unknown / bad input → null', () => {
    assert.equal(parseChartInterval('3min'), null)
    assert.equal(parseChartInterval('foo'),  null)
    assert.equal(parseChartInterval(''),     null)
    assert.equal(parseChartInterval(null),   null)
    assert.equal(parseChartInterval(42),     null)
})

// ── default lookback windows ──────────────────────────────────────────────────
test('finer bars get shorter default windows', () => {
    assert.equal(defaultLookbackDays('minute', 1),  3)
    assert.equal(defaultLookbackDays('minute', 5),  10)
    assert.equal(defaultLookbackDays('minute', 30), 40)
    assert.equal(defaultLookbackDays('hour', 1),    60)
    assert.equal(defaultLookbackDays('hour', 4),    150)
    assert.equal(defaultLookbackDays('day', 1),     730)
})
