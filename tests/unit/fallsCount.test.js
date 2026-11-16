import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quarterlyFromYtd, cashFlowAt, prepareCashFlow, compactCashFlow, lastQuarterNi } from '../../services/secFundamentals.service.js'
import { falls, analystsAt } from '../../scripts/lab-falls-count.mjs'

// screener-lab.md §52 — the cash flow as filed (10-Q cash flows are year-to-date) and the fall's count.

const d = (start, end, val, filed) => [start, end, val, filed]

test('year-to-date cash flows become quarters: each is its year-to-date less the one before', () => {
    const rows = [d('2025-01-01', '2025-03-31', 100, '2025-05-01'), d('2025-01-01', '2025-06-30', 250, '2025-08-01'),
        d('2025-01-01', '2025-09-30', 330, '2025-11-01'), d('2025-01-01', '2025-12-31', 500, '2026-02-20')]
    assert.deepEqual(quarterlyFromYtd(rows).map(q => [q.end, q.val, q.filed]),
        [['2025-03-31', 100, '2025-05-01'], ['2025-06-30', 150, '2025-08-01'], ['2025-09-30', 80, '2025-11-01'], ['2025-12-31', 170, '2026-02-20']])
})

test('cash flow as known on a day: nothing before its filing; four quarters and free cash flow once known', () => {
    const ocf = [d('2025-01-01', '2025-03-31', 100, '2025-05-01'), d('2025-01-01', '2025-06-30', 250, '2025-08-01'),
        d('2025-01-01', '2025-09-30', 330, '2025-11-01'), d('2025-01-01', '2025-12-31', 500, '2026-02-20')]
    const capex = ocf.map(([s, e, v, f]) => [s, e, v / 10, f])
    const cfq = prepareCashFlow({ ocf, capex })
    assert.equal(cashFlowAt(cfq, '2025-04-30').ocf_q, null)
    assert.deepEqual(cashFlowAt(cfq, '2025-11-15'), { ocf_q: 80, ocf_q_end: '2025-09-30', ocf_ttm: null, fcf_ttm: null })
    const full = cashFlowAt(cfq, '2026-03-01')
    assert.equal(full.ocf_ttm, 500)
    assert.equal(full.fcf_ttm, 450)
})

test('the first filing across the cash-flow names wins a period', () => {
    const f = (val, filed) => ({ start: '2025-01-01', end: '2025-03-31', val, filed, form: '10-Q' })
    const json = { facts: { 'us-gaap': { NetCashProvidedByUsedInOperatingActivities: { units: { USD: [f(100, '2025-05-01'), f(90, '2026-05-01')] } } } } }
    assert.deepEqual(compactCashFlow(json).ocf, [['2025-01-01', '2025-03-31', 100, '2025-05-01']])
    assert.deepEqual(compactCashFlow(json).capex, [])
})

test('the last quarter\'s net income as known on a day', () => {
    const f = { niQ: [{ end: '2025-03-31', val: -5, filed: '2025-05-01' }, { end: '2025-06-30', val: 3, filed: '2025-08-01' }] }
    assert.deepEqual(lastQuarterNi(f, '2025-07-01'), { end: '2025-03-31', val: -5 })
    assert.equal(lastQuarterNi(f, '2025-01-01'), null)
})

test('a fall: the first close 20% under the 60-session high, then not again for 60 sessions', () => {
    const closes = [...Array(60).fill(100), 85, 79, 78, ...Array(70).fill(78), 50]
    assert.deepEqual(falls(closes).map(e => e.i), [61, 133])
})

test('the analysts: none in the window → unknown; a downgrade or a target under +20% → did not stay', () => {
    const t = [['2026-06-02', 300, 228, -1], ['2026-06-16', 283, 231, 0], ['2026-01-01', 400, 250, 1]]
    assert.equal(analystsAt([], [], '2026-06-22', 230), null)
    const a = analystsAt([['2026-06-03', 'maintain']], t, '2026-06-22', 230.85)
    assert.equal(a.stayed, true)
    assert.ok(Math.abs(a.upside - ((291.5 / 230.85 - 1) * 100)) < 1e-9, 'median of the 90 days only')
    assert.equal(analystsAt([['2026-06-10', 'downgrade']], t, '2026-06-22', 230.85).stayed, false)
    assert.equal(analystsAt([], t, '2026-06-22', 260).stayed, false)
})
