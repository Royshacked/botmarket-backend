import { test } from 'node:test'
import assert from 'node:assert/strict'

import { nodeScores, spreads, spreadSummary, verdict, PASS } from '../../services/situation/scorecard.js'
import { runControl, controlSchema, _setIO } from '../../services/situation/control.js'

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`)

test('nodeScores: Brier against equal odds (1/k), per group; a question counts once', () => {
    const rows = [
        { run_id: 'r1', node_id: 'n1', option: 'yes', p: 0.8, set_by: 'llm', outcome: 1 },
        { run_id: 'r1', node_id: 'n1', option: 'no', p: 0.2, set_by: 'llm', outcome: 0 },
        { run_id: 'r2', node_id: 'n1', option: 'yes', p: 0.9, set_by: 'roy', llm_p: 0.6, outcome: 1 },
        { run_id: 'r2', node_id: 'n1', option: 'no', p: 0.1, set_by: 'roy', llm_p: 0.4, outcome: 0 },
        { run_id: 'r1', node_id: 'n2', option: 'a', p: 0.5, set_by: 'llm', outcome: null },
    ]
    const s = nodeScores(rows)
    assert.equal(s.all.questions, 1)
    assert.equal(s.all.rows, 4)
    near(s.accepted.brier, (0.04 + 0.04) / 2)
    near(s.accepted.equal_odds, 0.25)
    near(s.overridden.brier, (0.16 + 0.16) / 2, 1e-12)
    near(s.roy.brier, (0.01 + 0.01) / 2, 1e-12)
    const b = s.all.calibration.find(x => x.from === 0.8)
    assert.equal(b.n, 2)
    assert.equal(b.happened, 1)
})

test('spreads: long minus short against the average of all baskets, h bars after the call', () => {
    const dates = Array.from({ length: 30 }, (_, i) => `2025-01-${String(i + 1).padStart(2, '0')}`)
    const flat = (id) => ({ _id: id, dates, levels: dates.map(() => 100) })
    const up = { _id: 'sub_industry:L', dates, levels: dates.map((_, i) => (i > 5 ? 110 : 100)) }
    const index = [up, flat('sub_industry:S'), ...Array.from({ length: 10 }, (_, i) => flat(`sub_industry:f${i}`))]
    const out = spreads([{ as_of: '2025-01-03', long: ['sub_industry:L'], short: ['sub_industry:S'] }], index, 10)
    near(out[0].spread, 0.1)
    assert.equal(spreads([{ as_of: '2025-01-25', long: ['sub_industry:L'], short: ['sub_industry:S'] }], index, 10).length, 0, 'not enough bars after')
    assert.equal(spreads([{ as_of: '2025-01-03', long: [], short: ['sub_industry:S'] }], index, 10).length, 0, 'no long leg, no spread')
})

test('the verdict holds the declared rule', () => {
    const cal = [{ from: 0.8, to: 1, n: 20, said: 0.85, happened: 0.8 }]
    const good = { all: { questions: 120, brier: 0.15, equal_odds: 0.25, calibration: cal } }
    const m6 = spreadSummary([0.02, 0.03, 0.01, 0.04, 0.02, 0.03].map(spread => ({ spread })))
    const v = verdict(good, m6, '2026-01-01', '2027-01-15')
    assert.equal(v.pass, true, JSON.stringify(v.checks))
    assert.equal(verdict(good, m6, '2026-06-01', '2027-01-15').checks['5_twelve_months'], false)
    assert.equal(verdict({ all: { ...good.all, questions: PASS.minQuestions - 1 } }, m6, '2026-01-01', '2027-01-15').checks['1_brier_beats_equal_odds'], false)
    assert.equal(verdict({ all: { ...good.all, calibration: [{ ...cal[0], happened: 0.6 }] } }, m6, '2026-01-01', '2027-01-15').checks['2_calibrated'], false)
    const mixed = spreadSummary([-0.02, -0.01, -0.03, 0.05, 0.06, 0.04].map(spread => ({ spread })))
    assert.equal(verdict(good, mixed, '2026-01-01', '2027-01-15').checks['4_same_sign_both_halves'], false)
})

test('runControl: the plain question stored by date; unknown codes and impossible numbers dropped', async () => {
    let stored = null
    _setIO({ payer: async () => null, db: async () => ({ collection: () => ({ updateOne: async (q, u) => { stored = u.$set } }) }),
        call: async (a) => { a.onUsage({ input_tokens: 1000, output_tokens: 200 }, 'claude-opus-5-5'); return { data: { industries: [{ code: 'G', p_win: 0.7, p_lose: 0.1 }, { code: 'X', p_win: 0.5, p_lose: 0.1 }, { code: 'H', p_win: 0.8, p_lose: 0.5 }] } } } })
    const r = await runControl({ sections: { regime: [] } }, [{ code: 'G', name: 'Gold', level: 'industry' }, { code: 'H', name: 'Homes', level: 'industry' }], '2025-01-07')
    assert.equal(r.ok, true)
    assert.deepEqual(stored.rows.map(x => x.code), ['G'])
    assert.equal(stored.as_of, '2025-01-07')
    assert.equal(controlSchema().properties.industries.items.additionalProperties, false)
})
