import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _calendarWeek } from '../../api/calendar/calendar.controller.js'

// Construct at local noon so getDay()/getDate() (local) and toISOString() (UTC)
// agree on the calendar day — mirrors how the function itself mixes the two.
const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0)

test('week window: a weekday runs from today through that week\'s Friday', () => {
    // 2026-07-01 is a Wednesday.
    assert.deepEqual(_calendarWeek(at(2026, 7, 1)), { from: '2026-07-01', to: '2026-07-03' })
    // 2026-07-02 Thursday.
    assert.deepEqual(_calendarWeek(at(2026, 7, 2)), { from: '2026-07-02', to: '2026-07-03' })
    // 2026-07-03 Friday → single day.
    assert.deepEqual(_calendarWeek(at(2026, 7, 3)), { from: '2026-07-03', to: '2026-07-03' })
    // 2026-06-29 Monday → full Mon–Fri (crosses the month boundary).
    assert.deepEqual(_calendarWeek(at(2026, 6, 29)), { from: '2026-06-29', to: '2026-07-03' })
})

test('week window: a weekend rolls forward to the coming Mon–Fri', () => {
    // 2026-07-04 Saturday → next week Mon 6th … Fri 10th.
    assert.deepEqual(_calendarWeek(at(2026, 7, 4)), { from: '2026-07-06', to: '2026-07-10' })
    // 2026-07-05 Sunday → Mon 6th … Fri 10th.
    assert.deepEqual(_calendarWeek(at(2026, 7, 5)), { from: '2026-07-06', to: '2026-07-10' })
})
