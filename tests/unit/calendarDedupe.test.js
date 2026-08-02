import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeByDaySymbol } from '../../api/calendar/calendar.service.js'

test('dedupe: one row survives per symbol+date, in original order', () => {
    const out = dedupeByDaySymbol([
        { symbol: 'SHAZ', date: '2026-08-03', time: 'bmo' },
        { symbol: 'AAPL', date: '2026-08-03', time: 'amc' },
        { symbol: 'SHAZ', date: '2026-08-03', time: 'bmo' },
    ])
    assert.equal(out.length, 2)
    assert.deepEqual(out.map(r => r.symbol), ['SHAZ', 'AAPL'])
})

test('dedupe: the same symbol on a different date is not a duplicate', () => {
    const out = dedupeByDaySymbol([
        { symbol: 'SHAZ', date: '2026-08-03' },
        { symbol: 'SHAZ', date: '2026-08-04' },
    ])
    assert.equal(out.length, 2)
})

test('dedupe: a sparse first row is filled from its duplicate, never overwritten', () => {
    const [row] = dedupeByDaySymbol([
        { symbol: 'SHAZ', date: '2026-08-03', time: 'bmo', epsEstimated: null, revenueEstimated: 4 },
        { symbol: 'SHAZ', date: '2026-08-03', time: 'amc', epsEstimated: 1.2, revenueEstimated: 9 },
    ])
    assert.equal(row.epsEstimated, 1.2)      // filled from the duplicate
    assert.equal(row.revenueEstimated, 4)    // first-wins — not clobbered
    assert.equal(row.time, 'bmo')
})

test('dedupe: symbol-less rows all pass through (no identity to collide on)', () => {
    const out = dedupeByDaySymbol([
        { symbol: null, date: '2026-08-03', name: 'Pending IPO' },
        { symbol: null, date: '2026-08-03', name: 'Another' },
    ])
    assert.equal(out.length, 2)
})

test('dedupe: an empty list stays empty', () => {
    assert.deepEqual(dedupeByDaySymbol([]), [])
})
