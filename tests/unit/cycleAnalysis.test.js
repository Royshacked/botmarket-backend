import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findExtrema, cycleStats, fmtDuration, fmtDateTimeUTC } from '../../services/cycleAnalysis.service.js'

// ── fmtDuration (bars → wall-clock, used by the intraday cycle read) ──────
test('fmtDuration: sub-hour → minutes', () => {
    assert.equal(fmtDuration(0), '0m')
    assert.equal(fmtDuration(45), '45m')
    assert.equal(fmtDuration(59.4), '59m')          // rounds
})
test('fmtDuration: hours, with and without remainder minutes', () => {
    assert.equal(fmtDuration(60), '1h')
    assert.equal(fmtDuration(90), '1h 30m')
    assert.equal(fmtDuration(23 * 60), '23h')
})
test('fmtDuration: days, with and without remainder hours', () => {
    assert.equal(fmtDuration(24 * 60), '1d')
    assert.equal(fmtDuration(25 * 60), '1d 1h')
    assert.equal(fmtDuration(50 * 60), '2d 2h')
})
test('fmtDuration: negatives clamp to 0', () => {
    assert.equal(fmtDuration(-10), '0m')
})

// ── fmtDateTimeUTC ───────────────────────────────────────────────────────
test('fmtDateTimeUTC: ms → "yyyy-mm-dd hh:mm" UTC', () => {
    assert.equal(fmtDateTimeUTC(Date.UTC(2026, 6, 13, 14, 30, 0)), '2026-07-13 14:30')
})

// ── the shared cycle math still behaves (sanity, unchanged by intraday work) ──
test('findExtrema + cycleStats: a clean periodic wave yields a stable interval', () => {
    // sine-ish wave, period 8 samples
    const closes = Array.from({ length: 48 }, (_, i) => 100 + Math.sin((i / 8) * 2 * Math.PI) * 5)
    const { peaks, troughs } = findExtrema(closes, 2)
    assert.ok(peaks.length >= 3 || troughs.length >= 3)
    const stats = cycleStats(troughs.length >= 3 ? troughs : peaks)
    assert.ok(stats && stats.mean >= 6 && stats.mean <= 10)   // ~8-sample period
})
