import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HYPOTHESES } from '../../services/screenerLab.service.js'
import { LIBRARY, LIBRARY_M } from '../../services/rotation.service.js'
import { indexEvents } from '../../services/sp500History.service.js'

// Test M (Roy, 2026-10-27: "build the new rules and rerun the rotation") — the five new rules, screener-lab.md §31.

const D = (k) => `2026-02-${String(k + 1).padStart(2, '0')}`
function ctx(closes, { i, reports = new Map(), spy = null, volume = null, bar = {}, name = {} } = {}) {
    const date = closes.map((_, k) => D(k))
    const rows = closes.map((c, k) => ({ open: c, close: c, high: c, low: c, volume: volume?.[k] ?? 1000, ...(bar[k] ?? {}) }))
    const spyByDay = new Map(date.map((d, k) => [d, { open: 400, close: spy?.[k] ?? 400 }]))
    return { rows, i, ind: { date }, reports, name, data: { spyByDay } }
}

test('report_popped: 5%+ over SPY from the close before the report to the close after it, on a beat — day two', () => {
    const c = [100, 100, 100, 104, 107, 107]
    const beat = new Map([[D(3), { epsActual: 1.1, epsEstimated: 1 }]])
    assert.equal(HYPOTHESES.report_popped.signal(ctx(c, { i: 5, reports: beat })), 'up 5-10%')
    assert.equal(HYPOTHESES.report_popped.signal(ctx(c, { i: 5, reports: new Map([[D(3), { epsActual: 0.9, epsEstimated: 1 }]]) })), null, 'a miss')
    assert.equal(HYPOTHESES.report_popped.signal(ctx(c, { i: 5, reports: beat, spy: [400, 400, 400, 404, 412, 412] })), null, 'SPY took 3 of the 7')
    assert.equal(HYPOTHESES.report_popped.signal(ctx(c, { i: 4, reports: beat })), null, 'only on day two')
})

test('report_sold: 5%+ under SPY, any surprise, by size', () => {
    const rep = new Map([[D(3), { epsActual: 1.1, epsEstimated: 1 }]])
    assert.equal(HYPOTHESES.report_sold.signal(ctx([100, 100, 100, 95, 88, 88], { i: 5, reports: rep })), 'down 10%+')
    assert.equal(HYPOTHESES.report_sold.signal(ctx([100, 100, 100, 98, 94, 94], { i: 5, reports: rep })), 'down 5-10%')
    assert.equal(HYPOTHESES.report_sold.signal(ctx([100, 100, 100, 98, 94, 94], { i: 5 })), null, 'no report')
})

test('index_added / index_removed: the first session on or after the effective date, once', () => {
    const name = { indexAdded: ['2026-02-04'], indexRemoved: ['2026-02-07'] } // the 7th is a Saturday in the test's world: next session
    const dates = ['2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06', '2026-02-09', '2026-02-10']
    const x = (i) => ({ i, ind: { date: dates }, name })
    assert.equal(HYPOTHESES.index_added.signal(x(2)), true)
    assert.equal(HYPOTHESES.index_added.signal(x(3)), null)
    assert.equal(HYPOTHESES.index_removed.signal(x(5)), true, 'Monday after a weekend date')
    assert.equal(HYPOTHESES.index_removed.signal(x(6)), null)
    assert.equal(HYPOTHESES.index_removed.signal({ ...x(5), name: {} }), null, 'no events, no signal')
})

test('indexEvents: a span start after the floor is an addition, an end a removal', () => {
    const ev = indexEvents({ A: [['2017-11-01', '2020-03-02']], B: [['2021-06-01', null]], C: [['2017-11-01', null]], D: [['2018-01-02', '2019-01-02'], ['2022-01-03', null]] }, '2017-11-01')
    assert.deepEqual(ev.A, { added: [], removed: ['2020-03-02'] })
    assert.deepEqual(ev.B, { added: ['2021-06-01'], removed: [] })
    assert.equal(ev.C, undefined)
    assert.deepEqual(ev.D, { added: ['2018-01-02', '2022-01-03'], removed: ['2019-01-02'] })
})

test('capitulation: down 6%+ vs SPY on 3x the 20-session volume, no report — by where it closed', () => {
    const c = Array(23).fill(100); c[22] = 92
    const volume = Array(23).fill(1000); volume[22] = 3000
    const bar = { 22: { high: 96, low: 90, close: 92 } }
    assert.equal(HYPOTHESES.capitulation.signal(ctx([...c, 92], { i: 23, volume: [...volume, 1000], bar })), 'closed bottom half')
    assert.equal(HYPOTHESES.capitulation.signal(ctx([...c, 92], { i: 23, volume: [...volume.slice(0, 22), 2500, 1000], bar })), null, 'volume under 3x')
    assert.equal(HYPOTHESES.capitulation.signal(ctx([...c, 92], { i: 23, volume: [...volume, 1000], bar, reports: new Map([[D(21), {}]]) })), null, 'a report the day before')
    assert.equal(HYPOTHESES.capitulation.signal(ctx([...c, 92], { i: 23, volume: [...volume, 1000], bar: { 22: { high: 93, low: 90, close: 92 } } })), 'closed top half')
})

test('LIBRARY_M is the 14 and the five new rules, each a lab hypothesis', () => {
    assert.equal(Object.keys(LIBRARY_M).length, Object.keys(LIBRARY).length + 5)
    for (const rule of Object.keys(LIBRARY_M)) assert.ok(HYPOTHESES[rule], rule)
})
