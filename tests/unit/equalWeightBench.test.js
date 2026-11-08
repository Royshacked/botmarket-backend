import { test } from 'node:test'
import assert from 'node:assert/strict'
import { equalWeightBars, prepare } from '../../services/screenerLab.data.js'

// The equal-weight market that nets the lab's tests under LAB_BENCH=ew (screener-lab.md §45).

const name = (dates, bars) => ({ ind: { date: dates }, rows: bars.map(([open, close]) => ({ open, close })) })
const DAYS = ['2025-01-02', '2025-01-03', '2025-01-06']
const SPY = new Map(DAYS.map((d, n) => [d, { open: 500 + n, close: 500 + n }]))

test('each session the mean of the members\' returns, chained from 100', () => {
    const names = new Map([['A', name(DAYS, [[10, 10], [10, 11], [11, 11]])], ['B', name(DAYS, [[20, 20], [19, 18], [18, 18]])]])
    const ew = equalWeightBars(names, DAYS, SPY)
    assert.equal(ew.get(DAYS[0]).close, 100)
    // Day two: A +10%, B −10% close to close → flat; opens A 0%, B −5% → −2.5%.
    assert.ok(Math.abs(ew.get(DAYS[1]).close - 100) < 1e-9)
    assert.ok(Math.abs(ew.get(DAYS[1]).open - 97.5) < 1e-9)
})

test('only members count, and a name missing the session before is left out', () => {
    const names = new Map([['A', name(DAYS, [[10, 10], [10, 11], [11, 12.1]])], ['B', name([DAYS[0], DAYS[2]], [[20, 20], [40, 40]])]])
    const onlyA = equalWeightBars(names, DAYS, SPY, (s) => s === 'A')
    assert.ok(Math.abs(onlyA.get(DAYS[2]).close - 121) < 1e-9)
    const both = equalWeightBars(names, DAYS, SPY)
    assert.ok(Math.abs(both.get(DAYS[2]).close - 121) < 1e-9, 'B has no bar on day two, so its doubling is not a day\'s move')
})

test('a bad print is clipped, and a session with no member takes SPY\'s move', () => {
    const names = new Map([['A', name(DAYS.slice(0, 2), [[10, 10], [10, 100]])]])
    const ew = equalWeightBars(names, DAYS, SPY)
    assert.equal(ew.get(DAYS[1]).close, 200, '+900% is clipped to +100%')
    assert.ok(Math.abs(ew.get(DAYS[2]).close / ew.get(DAYS[1]).close - 502 / 501) < 1e-12)
})

test('prepare: bench "ew" swaps the benchmark and keeps SPY beside it', () => {
    const ts = (d) => Date.parse(`${d}T21:00:00Z`) / 1000
    const raw = { spy: DAYS.map((d, n) => ({ timestamp: ts(d), open: 500 + n, close: 500 + n })),
        names: { A: Array.from({ length: 40 }, (_, n) => ({ timestamp: ts(DAYS[0]) + n * 86400, open: 10, close: 10, high: 10, low: 10, volume: 1 })) } }
    const spy = prepare(raw), ew = prepare(raw, {}, { bench: 'ew' })
    assert.equal(spy.spyByDay, spy.spyRealByDay)
    assert.notEqual(ew.spyByDay, ew.spyRealByDay)
    assert.equal(ew.spyRealByDay.get(DAYS[1]).close, 501)
    assert.equal(ew.bench, 'ew')
})
