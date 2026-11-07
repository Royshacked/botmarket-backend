import { test } from 'node:test'
import assert from 'node:assert/strict'
import { holdTrades, holdBook, bookBlocks, holdVerdict, isGoodReport, revenueBeat } from '../../services/holdToNext.service.js'

// Good earnings, held to the next earnings (Roy, 2026-11-07: test N).

const dates = Array.from({ length: 300 }, (_, n) => new Date(Date.UTC(2024, 0, 1 + n)).toISOString().slice(0, 10))

/** A name: rows from `close(n)`, open = close, reports {barIndex: report}. SPY flat at 100 unless given. */
function dataOf({ close, reports, len = 300, spy = () => 100 }) {
    const rows = Array.from({ length: len }, (_, n) => ({ open: close(n), close: close(n), high: close(n), low: close(n), volume: 1e6 }))
    const ind = { date: dates.slice(0, len), adv20: rows.map(() => 200e6) }
    const spyDays = dates
    const spyByDay = new Map(dates.map((d, n) => [d, { open: spy(n), close: spy(n) }]))
    const rep = new Map(Object.entries(reports).map(([n, r]) => [dates[n], r]))
    return { names: new Map([['A', { rows, ind, reports: rep }]]), spyByDay, spyDays }
}
const GOOD = { epsActual: 1.2, epsEstimated: 1, revenueActual: 110, revenueEstimated: 100 }

test('good earnings: EPS over +2% and revenue over its estimate, both', () => {
    assert.equal(isGoodReport(20, true), true)
    assert.equal(isGoodReport(2, true), false)
    assert.equal(isGoodReport(20, false), false)
    assert.equal(isGoodReport(20, null), false, 'an unknown revenue is not a good report')
    assert.equal(isGoodReport(null, true), false)
    assert.equal(revenueBeat({ revenueActual: 110, revenueEstimated: 100 }), true)
    assert.equal(revenueBeat({ revenueActual: 90, revenueEstimated: 100 }), false)
    assert.equal(revenueBeat({ revenueActual: null, revenueEstimated: 100 }), null)
})

test('bought at the open of the second session after the report, sold at the close before the next one', () => {
    const data = dataOf({ close: (n) => 100 + n, reports: { 70: GOOD, 130: GOOD } })
    const { trades } = holdTrades(data)
    const t = trades.find(x => x.i === 72)
    assert.ok(t, 'entered on bar k + 2')
    assert.equal(t.x, 129, 'out on the bar before the next report')
    assert.equal(t.good, true)
    assert.equal(t.held, 58)
    assert.ok(Math.abs(t.ret - ((229 / 172 - 1) * 100)) < 1e-9)
    assert.equal(t.spy, 0)
    assert.ok(Math.abs(t.net - (t.ret - t.cost)) < 1e-9, 'net of SPY and the cost')
})

test('the hold splits into the part before the run-up window and the window itself, summing to the whole when SPY is flat', () => {
    const data = dataOf({ close: (n) => 100 + n, reports: { 70: GOOD, 130: GOOD } })
    const t = holdTrades(data).trades.find(x => x.i === 72)
    assert.ok(Math.abs(t.body - ((224 / 172 - 1) * 100)) < 1e-9)
    assert.ok(Math.abs(t.last - ((229 / 224 - 1) * 100)) < 1e-9)
})

test('a name whose bars end before the next report is sold at its last close and stays counted', () => {
    const data = dataOf({ close: () => 100, reports: { 70: GOOD }, len: 100 })
    const { trades } = holdTrades(data)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].ended, true)
    assert.equal(trades[0].x, 99)
    assert.equal(trades[0].body, null, 'no next report, so no run-up window to split out')
})

test('the last report of a live name has no finished hold, and is left out, counted', () => {
    const data = dataOf({ close: () => 100, reports: { 70: GOOD } })
    const { trades, out } = holdTrades(data)
    assert.equal(trades.length, 0)
    assert.equal(out.no_next, 1)
})

test('a next report too near or too far is a calendar problem, not a hold', () => {
    assert.equal(holdTrades(dataOf({ close: () => 100, reports: { 70: GOOD, 90: GOOD } })).out.gap, 1)
    assert.equal(holdTrades(dataOf({ close: () => 100, reports: { 70: GOOD, 200: GOOD } })).out.gap, 1)
})

test('only a member on the entry day is bought', () => {
    const data = dataOf({ close: () => 100, reports: { 70: GOOD, 130: GOOD } })
    const { trades, out } = holdTrades(data, { member: () => false })
    assert.equal(trades.length, 0)
    assert.equal(out.not_member, 2)
})

test('the book counts each session once, takes the cost on the first session, and adds up to the trade on a flat SPY', () => {
    const data = dataOf({ close: (n) => 100 + n, reports: { 70: GOOD, 130: GOOD } })
    const t = holdTrades(data).trades.find(x => x.i === 72)
    const book = holdBook(data, [t])
    assert.equal(book.size, t.held)
    assert.ok([...book.values()].every(b => b.n === 1))
    const compounded = [...book.values()].map((b, n) => (n === 0 ? b.sum + t.cost : b.sum)).reduce((a, r) => a * (1 + r / 100), 1)
    assert.ok(Math.abs((compounded - 1) * 100 - t.ret) < 1e-6)
    assert.equal(book.get(dates[72]).sum, -t.cost, 'bought at the open, close = open in this fixture')
})

test('bookBlocks: non-overlapping blocks, a flat session counts, too few blocks is no answer', () => {
    const days = dates.slice(0, 42)
    const book = new Map(days.map((d, n) => [d, { sum: n < 21 ? 1 : 3, n: 1 }]))
    const r = bookBlocks(book, days)
    assert.equal(r.blocks, 2)
    assert.equal(r.mean, 42)
    assert.equal(bookBlocks(new Map(), days.slice(0, 21)), null)
    assert.equal(bookBlocks(new Map(), days).mean, 0)
})

test('the bar needs all three: above SPY in both periods, above every report in both, t of 2', () => {
    const r = (mean, t = null) => ({ mean, t })
    const all = { whole: r(0.1), before: r(0.1), after: r(0.1) }
    assert.equal(holdVerdict({ whole: r(1, 2.5), before: r(1), after: r(1) }, all).pass, true)
    assert.equal(holdVerdict({ whole: r(1, 1.9), before: r(1), after: r(1) }, all).pass, false)
    assert.equal(holdVerdict({ whole: r(1, 2.5), before: r(1), after: r(-1) }, all).pass, false)
    assert.equal(holdVerdict({ whole: r(1, 2.5), before: r(0.05), after: r(1) }, all).pass, false)
    assert.equal(holdVerdict({ whole: null, before: null, after: null }, all).pass, false)
})
