import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fundChanges, publicDay, quintiles, capLookup, factsKnown, MAX_JUMP } from '../../services/fundFlow.service.js'

// The funds (13F) — test G (Roy, 2026-10-26: "start with EDGAR").

const row = (symbol, quarter, value, holders) => ({ symbol, quarter, value, holders })

test('publicDay is the day after the 45-day filing deadline', () => {
    assert.equal(publicDay('2026-06-30'), '2026-08-15')
    assert.equal(publicDay('2025-12-31'), '2026-02-15')
    assert.equal(publicDay('2025-12-31', 0), '2025-12-31')
})

test('fundChanges: ownership in points of the cap at each quarter end, breadth in log points', () => {
    const caps = { 'A|2026-03-31': 1000, 'A|2026-06-30': 2000 }
    const out = fundChanges([row('A', '2026-03-31', 500, 100), row('A', '2026-06-30', 1200, 110)], (s, q) => caps[`${s}|${q}`])
    assert.equal(out.length, 1)
    const c = out[0]
    assert.equal(c.quarter, '2026-06-30')
    assert.equal(c.prev, '2026-03-31')
    assert.equal(Math.round(c.f.own_chg * 1e6) / 1e6, 10)          // 50% → 60%: the price doubled, the funds bought more
    assert.equal(Math.round(c.f.own_level * 1e6) / 1e6, 60)
    assert.equal(Math.round(c.f.holders_chg * 1e4) / 1e4, Math.round(Math.log(1.1) * 1e6) / 1e4)
})

test('fundChanges: the first quarter, a missing cap and a gap of a quarter are skipped', () => {
    const rows = [row('A', '2026-03-31', 500, 100), row('B', '2026-03-31', 500, 100), row('B', '2026-06-30', 500, 100),
        row('C', '2025-12-31', 500, 100), row('C', '2026-06-30', 500, 100)]
    const out = fundChanges(rows, (s) => (s === 'B' ? null : 1000))
    // A: no quarter before · B: no cap · C: 2026-03-31 missing, so 2026-06-30 has no previous row
    assert.deepEqual(out, [])
})

test(`fundChanges: ownership that moves more than ${MAX_JUMP}x is a break and is dropped`, () => {
    const cap = () => 1000
    assert.equal(fundChanges([row('A', '2026-03-31', 100, 10), row('A', '2026-06-30', 250, 10)], cap).length, 0)
    assert.equal(fundChanges([row('A', '2026-03-31', 250, 10), row('A', '2026-06-30', 100, 10)], cap).length, 0)
    assert.equal(fundChanges([row('A', '2026-03-31', 100, 10), row('A', '2026-06-30', 200, 10)], cap).length, 1)
})

test('fundChanges: no holders on either side is skipped (no log of zero)', () => {
    assert.equal(fundChanges([row('A', '2026-03-31', 100, 0), row('A', '2026-06-30', 120, 10)], () => 1000).length, 0)
})

test('quintiles are cut within each quarter, and a missing value is left out', () => {
    const mk = (q, v) => ({ quarter: q, f: { x: v } })
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => mk('Q1', v))
    const b = [100, 200, 300, 400, 500].map(v => mk('Q2', v))
    const none = mk('Q2', null)
    const q = quintiles([...a, ...b, none], 'x')
    assert.deepEqual(a.map(c => q.get(c)), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
    assert.deepEqual(b.map(c => q.get(c)), [1, 2, 3, 4, 5])          // its own cuts, not Q1's
    assert.equal(q.has(none), false)
})

test('capLookup: today’s cap scaled by the close at the quarter end; null with no cap or no bar near the date', () => {
    const data = { names: new Map([['A', { ind: { date: ['2026-03-30', '2026-03-31', '2026-10-23'] }, rows: [{ close: 10 }, { close: 20 }, { close: 40 }] }]]) }
    const capOn = capLookup(data, new Map([['A', 4000]]))
    assert.equal(capOn('A', '2026-03-31'), 2000)
    assert.equal(capOn('A', '2026-04-01'), 2000)          // the last bar on or before
    assert.equal(capOn('A', '2026-06-30'), null)           // no bar within a week
    assert.equal(capOn('A', '2026-03-01'), null)           // before the first bar
    assert.equal(capLookup(data, new Map())('A', '2026-03-31'), null)
})

test('factsKnown: the latest change public on the day, none before its public day', () => {
    const c1 = { symbol: 'A', quarter: '2026-03-31' }, c2 = { symbol: 'A', quarter: '2026-06-30' }
    const known = factsKnown([c2, c1])
    assert.equal(known('A', '2026-05-15'), null)           // Q1's public day is 2026-05-16
    assert.equal(known('A', '2026-05-16'), c1)
    assert.equal(known('A', '2026-08-14'), c1)
    assert.equal(known('A', '2026-08-15'), c2)
    assert.equal(known('B', '2026-08-15'), null)
})
