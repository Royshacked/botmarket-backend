import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmpDateToEpochSec, fmpCandleSpec, groupOhlcByPeriod, etPeriodKey, etCalendarDate } from '../../providers/fmp.price.provider.js'
import { aggregateCandles } from '../../services/candleInterval.util.js'
import { barBucketOf } from '../../services/market.service.js'

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

// ── aggregateCandles — ONE aggregate now (candleInterval.util), used by FMP and the agents' tools ──
const bar = (t, o, h, l, c, v) => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: v })

test('groups N ascending bars into one: first open, last close, max high, min low, sum vol', () => {
    const rows = [bar(1, 10, 12, 9, 11, 100), bar(2, 11, 15, 10, 14, 200)]
    const out  = aggregateCandles(rows, 2)
    assert.equal(out.length, 1)
    assert.deepEqual(out[0], { timestamp: 1, open: 10, high: 15, low: 9, close: 14, volume: 300 })
})

test('aligns to the newest bar — drops the oldest partial group', () => {
    // 5 rows, groupSize 2 → drop oldest 1, two groups of 2 (bars 2-3, 4-5)
    const rows = [1, 2, 3, 4, 5].map(i => bar(i, i, i, i, i, 10))
    const out  = aggregateCandles(rows, 2)
    assert.equal(out.length, 2)
    assert.equal(out[0].timestamp, 2)
    assert.equal(out[1].timestamp, 4)
    assert.equal(out[1].close, 5)
})

test('groupSize 1 or empty → passthrough', () => {
    const rows = [bar(1, 1, 1, 1, 1, 1)]
    assert.equal(aggregateCandles(rows, 1), rows)
    assert.deepEqual(aggregateCandles([], 4), [])
})

// ── With a bucket: the instrument's real bars (market.service barBucketOf) ────
// The EXPD hourlies of 2026-10-16 and -19 (FMP, as served): a 4hr read is the 09:30–13:30 and
// 13:30–16:00 bars FMP itself publishes — the Oct 19 retest bar low 196.00, close 197.60.
const ET = (d, t) => fmpDateToEpochSec(`${d} ${t}:00`)
const EXPD_1H = [
    ['2026-10-16', '09:30', 199.82, 200.42, 198.64, 198.96], ['2026-10-16', '10:30', 199.13, 199.49, 197.51, 197.53],
    ['2026-10-16', '11:30', 197.5, 197.63, 194.17, 195.32],  ['2026-10-16', '12:30', 195.56, 196.17, 195.36, 195.81],
    ['2026-10-16', '13:30', 195.92, 196.13, 195.36, 195.53], ['2026-10-16', '14:30', 195.61, 196.23, 195.51, 196.12],
    ['2026-10-16', '15:30', 196, 196.2, 195.28, 195.83],
    ['2026-10-19', '09:30', 196.9, 197.9, 196.29, 196.37],   ['2026-10-19', '10:30', 196.31, 196.83, 196, 196.79],
    ['2026-10-19', '11:30', 196.71, 196.98, 196.46, 196.94], ['2026-10-19', '12:30', 196.9, 197.79, 196.82, 197.6],
].map(([d, t, o, h, l, c]) => bar(ET(d, t), o, h, l, c, 1))

test('bucketed: EXPD hourlies fold into FMP\'s own 4hr bars, not fours from the newest', () => {
    const out = aggregateCandles(EXPD_1H, 4, barBucketOf('EXPD', null, 240))
    assert.deepEqual(out.map(b => [b.timestamp, b.low, b.close]), [
        [ET('2026-10-16', '09:30'), 194.17, 195.81],
        [ET('2026-10-16', '13:30'), 195.28, 195.83],
        [ET('2026-10-19', '09:30'), 196,    197.6],
    ])
    // Counted in fours from the newest, the same rows give a Friday "4hr" bar of 12:30–16:00 — a bar
    // FMP never published, whose start moves with every new hourly. Its low hides the 11:30 wick.
    const counted = aggregateCandles(EXPD_1H, 4)
    assert.equal(counted[0].timestamp, ET('2026-10-16', '12:30'), 'the old way: a bar starting at 12:30')
    assert.equal(counted[0].low, 195.28)
})

test('bucketed: an oldest bucket the window cut into is dropped; a forming newest is kept', () => {
    const cut = EXPD_1H.slice(2)   // starts at 11:30 — half of the 09:30 bucket is missing
    const out = aggregateCandles(cut, 4, barBucketOf('EXPD', null, 240))
    assert.equal(out[0].timestamp, ET('2026-10-16', '13:30'), 'a 4hr bar with half its hours would lie about its range')
    assert.equal(out.at(-1).timestamp, ET('2026-10-19', '09:30'))
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

// ── etPeriodKey / etCalendarDate: which market day an INSTANT belongs to ───────
// The grouping above only ever asked this of a bar stamped at ET midnight, where UTC getters
// happened to give the right answer. The forming-bar builder asks it of a live quote — an instant
// anywhere in the session — and there the ET resolution is the whole thing.

test('etPeriodKey: an after-hours print stays on ITS market day, not the UTC one', () => {
    // 20:30 ET on Mon 2026-08-17 is 00:30Z Tuesday. UTC getters would file it under the 18th and
    // open a day that has not traded; a weekly key would eventually jump the week the same way.
    const afterHours = Date.parse('2026-08-18T00:30:00Z')
    assert.equal(etCalendarDate(afterHours), '2026-08-17')
    assert.equal(etPeriodKey(afterHours, 'day'), '2026-08-17')
    assert.equal(etPeriodKey(afterHours, 'week'), '2026-08-17')   // Monday opens that week
    assert.equal(etPeriodKey(afterHours, 'month'), '2026-08')
})

test('etPeriodKey: a bar stamped at ET midnight keys to its own trading date', () => {
    // The equivalence that let the grouping share this definition rather than keep its own.
    assert.equal(etPeriodKey(fmpDateToEpochSec('2026-08-14') * 1000, 'day'), '2026-08-14')
    assert.equal(etPeriodKey(fmpDateToEpochSec('2026-08-14') * 1000, 'week'), '2026-08-10')
})

test('etPeriodKey: unusable input is null, never a plausible date', () => {
    assert.equal(etCalendarDate(NaN), null)
    assert.equal(etPeriodKey(undefined, 'day'), null)
})
