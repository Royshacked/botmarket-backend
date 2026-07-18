import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmpDateToEpochSec, aggregateOhlc, fmpCandleSpec, groupOhlcByPeriod } from '../../providers/fmp.price.provider.js'

// Stage 2 build-step 1 (reference_fmp_pricing): the pure pieces of the FMP candle provider.
// The timezone conversion is the critical one — FMP intraday dates are ET wall-clock, but the
// whole system speaks UTC epoch seconds; a wrong offset shifts every bar and misfires the monitor.

// ── fmpDateToEpochSec ────────────────────────────────────────────────────────
test('intraday ET → UTC epoch, summer (EDT, −4h)', () => {
    // 14:50 ET in July → 18:50 UTC
    assert.equal(fmpDateToEpochSec('2026-07-13 14:50:00'), Math.floor(Date.UTC(2026, 6, 13, 18, 50, 0) / 1000))
})

test('intraday ET → UTC epoch, winter (EST, −5h)', () => {
    // 09:30 ET in January → 14:30 UTC
    assert.equal(fmpDateToEpochSec('2026-01-15 09:30:00'), Math.floor(Date.UTC(2026, 0, 15, 14, 30, 0) / 1000))
})

test('accepts a T separator too', () => {
    assert.equal(fmpDateToEpochSec('2026-07-13T14:50:00'), fmpDateToEpochSec('2026-07-13 14:50:00'))
})

test('date-only (EOD) → ET midnight (matches Massive daily convention: 04:00Z EDT)', () => {
    // 2026-07-13 ET midnight in July (EDT, −4h) → 04:00 UTC
    assert.equal(fmpDateToEpochSec('2026-07-13'), Math.floor(Date.UTC(2026, 6, 13, 4, 0, 0) / 1000))
    // winter day (EST, −5h) → 05:00 UTC
    assert.equal(fmpDateToEpochSec('2026-01-15'), Math.floor(Date.UTC(2026, 0, 15, 5, 0, 0) / 1000))
})

test('unparseable input → null', () => {
    for (const bad of ['garbage', '', '2026/07/13', null, undefined, 42, '2026-13-40 99:99:99']) {
        assert.equal(fmpDateToEpochSec(bad), null, String(bad))
    }
})

// ── aggregateOhlc (mirror of marketData.tools.aggregateCandles) ───────────────
const bar = (t, o, h, l, c, v) => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: v })

test('groups N ascending bars into one: first open, last close, max high, min low, sum vol', () => {
    const rows = [bar(1, 10, 12, 9, 11, 100), bar(2, 11, 15, 10, 14, 200)]
    const out  = aggregateOhlc(rows, 2)
    assert.equal(out.length, 1)
    assert.deepEqual(out[0], { timestamp: 1, open: 10, high: 15, low: 9, close: 14, volume: 300 })
})

test('aligns to the newest bar — drops the oldest partial group', () => {
    // 5 rows, groupSize 2 → drop oldest 1, two groups of 2 (bars 2-3, 4-5)
    const rows = [1, 2, 3, 4, 5].map(i => bar(i, i, i, i, i, 10))
    const out  = aggregateOhlc(rows, 2)
    assert.equal(out.length, 2)
    assert.equal(out[0].timestamp, 2)
    assert.equal(out[1].timestamp, 4)
    assert.equal(out[1].close, 5)
})

test('groupSize 1 or empty → passthrough', () => {
    const rows = [bar(1, 1, 1, 1, 1, 1)]
    assert.equal(aggregateOhlc(rows, 1), rows)
    assert.deepEqual(aggregateOhlc([], 4), [])
})

// ── fmpCandleSpec (bar-spec → FMP fetch plan; null = fall back to Massive/Yahoo) ──
test('intraday minute intervals map natively', () => {
    for (const m of [1, 5, 15, 30]) {
        assert.deepEqual(fmpCandleSpec('minute', m), { kind: 'intraday', interval: `${m}min`, aggregate: 1 })
    }
    assert.equal(fmpCandleSpec('minute', 3), null)   // unsupported multiplier → fallback
})

test('hours: 1h/4h native, 2h aggregated from 1h', () => {
    assert.deepEqual(fmpCandleSpec('hour', 1), { kind: 'intraday', interval: '1hour', aggregate: 1 })
    assert.deepEqual(fmpCandleSpec('hour', 4), { kind: 'intraday', interval: '4hour', aggregate: 1 })
    assert.deepEqual(fmpCandleSpec('hour', 2), { kind: 'intraday', interval: '1hour', aggregate: 2 })
    assert.equal(fmpCandleSpec('hour', 3), null)
})

test('day → EOD; week/month → EOD grouped by calendar (built from daily)', () => {
    assert.deepEqual(fmpCandleSpec('day', 1),   { kind: 'eod', aggregate: 1 })
    assert.deepEqual(fmpCandleSpec('week', 1),  { kind: 'eod', aggregate: 1, groupBy: 'week' })
    assert.deepEqual(fmpCandleSpec('month', 1), { kind: 'eod', aggregate: 1, groupBy: 'month' })
    assert.equal(fmpCandleSpec('week', 2), null)   // odd multiplier still falls back
})

// ── groupOhlcByPeriod (daily EOD → weekly / monthly, since FMP has no native endpoint) ──
// Use real EOD timestamps (ET midnight) so the calendar bucketing is exercised end-to-end.
const eod = (dateStr, o, h, l, c, v) => bar(fmpDateToEpochSec(dateStr), o, h, l, c, v)

test('weekly: Mon–Fri collapse to one bar (first open, last close, extremes, sum vol)', () => {
    // Week of Mon 2026-07-13 … Fri 2026-07-17
    const week1 = [
        eod('2026-07-13', 10, 12, 9,  11, 100),
        eod('2026-07-14', 11, 15, 10, 14, 200),
        eod('2026-07-17', 14, 16, 13, 13, 150),
    ]
    // Next week starts Mon 2026-07-20 — must be a separate bucket
    const week2 = [eod('2026-07-20', 13, 14, 12, 13, 90)]
    const out = groupOhlcByPeriod([...week1, ...week2], 'week')
    assert.equal(out.length, 2)
    assert.deepEqual(
        { o: out[0].open, h: out[0].high, l: out[0].low, c: out[0].close, v: out[0].volume },
        { o: 10, h: 16, l: 9, c: 13, v: 450 },
    )
    assert.equal(out[0].timestamp, fmpDateToEpochSec('2026-07-13'))   // Monday's bar opens the week
    assert.equal(out[1].close, 13)
})

test('weekly: a Sunday-dated bar keys to the PRIOR Monday, not a new week', () => {
    // Fri 07-17 and (hypothetical) Sun 07-19 share the week of Mon 07-13
    const out = groupOhlcByPeriod([eod('2026-07-17', 1, 1, 1, 1, 1), eod('2026-07-19', 2, 2, 2, 2, 2)], 'week')
    assert.equal(out.length, 1)
})

test('monthly: same calendar month collapses; new month splits', () => {
    const out = groupOhlcByPeriod([
        eod('2026-07-13', 10, 12, 9,  11, 100),
        eod('2026-07-31', 11, 20, 8,  18, 200),
        eod('2026-08-03', 18, 19, 17, 17, 50),
    ], 'month')
    assert.equal(out.length, 2)
    assert.deepEqual({ o: out[0].open, h: out[0].high, l: out[0].low, c: out[0].close, v: out[0].volume }, { o: 10, h: 20, l: 8, c: 18, v: 300 })
    assert.equal(out[1].open, 18)
})

test('groupOhlcByPeriod: empty / non-array → passthrough', () => {
    assert.deepEqual(groupOhlcByPeriod([], 'week'), [])
    assert.equal(groupOhlcByPeriod(null, 'month'), null)
})
