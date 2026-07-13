import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmpDateToEpochSec, aggregateOhlc, fmpCandleSpec } from '../../providers/fmp.price.provider.js'

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

test('date-only (EOD) → UTC midnight of the day', () => {
    assert.equal(fmpDateToEpochSec('2026-07-13'), Math.floor(Date.UTC(2026, 6, 13) / 1000))
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

test('day → EOD; week/month → null (fallback keeps native weekly/monthly)', () => {
    assert.deepEqual(fmpCandleSpec('day', 1), { kind: 'eod', aggregate: 1 })
    assert.equal(fmpCandleSpec('week', 1), null)
    assert.equal(fmpCandleSpec('month', 1), null)
})
