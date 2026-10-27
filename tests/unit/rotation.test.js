import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dailyBook, LIBRARY } from '../../services/rotation.service.js'
import { HYPOTHESES } from '../../services/screenerLab.service.js'

// Which rule, when (Roy, 2026-10-27: test L) — a rule's trades as a daily book of excess over SPY.

const days = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']
function data(closes, opens, spy) {
    const rows = closes.map((c, k) => ({ open: opens[k], close: c }))
    return {
        names: new Map([['A', { rows, ind: { date: days, adv20: [200e6, 200e6, 200e6, 200e6] } }]]),
        spyDays: days, spyByDay: new Map(days.map((d, k) => [d, spy[k]])),
    }
}

test('the entry day open → close, then close → close, each less SPY’s; the cost once, on the entry day', () => {
    const dt = data([100, 110, 99, 99], [100, 100, 110, 99], [{ open: 400, close: 400 }, { open: 400, close: 404 }, { open: 404, close: 404 }, { open: 404, close: 404 }])
    const book = dailyBook([{ symbol: 'A', day: days[1], exit_day: days[2] }], dt)
    assert.equal(book.has(days[0]), false)
    assert.ok(Math.abs(book.get(days[1]).sum - (10 - 1 - 0.05)) < 1e-9, '+10% open → close, SPY +1%, the $100M+ cost 0.05%')
    assert.ok(Math.abs(book.get(days[2]).sum - (-10)) < 1e-9, '110 → 99 against a flat SPY')
    assert.equal(book.has(days[3]), false, 'out at the exit day’s close')
})

test('two positions on one day sum with their count (the rule’s day is their mean)', () => {
    const dt = data([100, 100, 100, 100], [100, 100, 100, 100], days.map(() => ({ open: 400, close: 400 })))
    const book = dailyBook([{ symbol: 'A', day: days[0], exit_day: days[1] }, { symbol: 'A', day: days[1], exit_day: days[1] }], dt)
    assert.equal(book.get(days[1]).n, 2)
})

test('every library rule is a lab hypothesis', () => {
    for (const rule of Object.keys(LIBRARY)) assert.ok(HYPOTHESES[rule], rule)
})
