import { test } from 'node:test'
import assert from 'node:assert/strict'

import { nodeScores, spreads, spreadSummary, verdict, callsOf, sides, sideSummary, byDistance, testScope, FAR_HORIZONS, HORIZONS, PASS } from '../../services/situation/scorecard.js'
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

test('spreads from a later bar: only the move between `from` and `h` counts; not enough bars, no grade', () => {
    const dates = Array.from({ length: 30 }, (_, i) => `2025-01-${String(i + 1).padStart(2, '0')}`)
    const flat = (id) => ({ _id: id, dates, levels: dates.map(() => 100) })
    const early = { _id: 'sub_industry:E', dates, levels: dates.map((_, i) => (i > 4 ? 150 : 100)) }   // moves before `from`
    const late = { _id: 'sub_industry:L', dates, levels: dates.map((_, i) => (i > 15 ? 110 : 100)) }
    const index = [early, late, flat('sub_industry:S'), ...Array.from({ length: 10 }, (_, i) => flat(`sub_industry:f${i}`))]
    const call = (long) => [{ as_of: '2025-01-03', long: [long], short: ['sub_industry:S'] }]
    near(spreads(call('sub_industry:E'), index, 20, 8)[0].spread, 0)
    near(spreads(call('sub_industry:L'), index, 20, 8)[0].spread, 0.1)
    near(spreads(call('sub_industry:E'), index, 20)[0].spread, 0.5)
    assert.equal(spreads(call('sub_industry:L'), index, 28, 8).length, 0)
    assert.equal(FAR_HORIZONS.m12.from, HORIZONS.m6, 'far starts where near ends')
})

test('callsOf: near from the row, far from its far score; a row with none (an old run) makes no far call', () => {
    const rows = [{ level: 'industry', code: 'A', p_win: 0.7, p_lose: 0, far: { p_win: 0, p_lose: 0.65 } }, { level: 'industry', code: 'B', p_win: 0.1, p_lose: 0.6 }]
    assert.deepEqual(callsOf(rows, 'd'), { as_of: 'd', long: ['industry:A'], short: ['industry:B'] })
    assert.deepEqual(callsOf(rows, 'd', r => r.far), { as_of: 'd', long: [], short: ['industry:A'] })
})

test('byDistance: by the days from when the number was set to its resolve-by date; overdue counts as under 6 months, undated nowhere', () => {
    const setOn = new Map([['r1', '2026-01-01']])
    const row = (node_id, resolve_by) => [{ run_id: 'r1', node_id, option: 'y', p: 0.8, set_by: 'llm', outcome: 1, resolve_by }, { run_id: 'r1', node_id, option: 'n', p: 0.2, set_by: 'llm', outcome: 0, resolve_by }]
    const d = byDistance([...row('a', '2026-03-31'), ...row('b', '2026-07-03'), ...row('c', '2026-07-04'), ...row('d', '2027-06-30'), ...row('e', null), ...row('f', '2025-12-30')], setOn)
    assert.deepEqual([d.under_6m.questions, d['6_to_12m'].questions, d.over_12m.questions], [3, 1, 1])
})

test('runControl keeps the far pair; an impossible one is dropped, not the row', async () => {
    let stored = null
    _setIO({ payer: async () => null, db: async () => ({ collection: () => ({ updateOne: async (q, u) => { stored = u.$set } }) }),
        call: async () => ({ data: { industries: [{ code: 'G', p_win: 0.7, p_lose: 0.1, far_win: 0.2, far_lose: 0.6 }, { code: 'H', p_win: 0.5, p_lose: 0.1, far_win: 0.8, far_lose: 0.8 }] } }) })
    await runControl({ sections: { regime: [] } }, [{ code: 'G', name: 'Gold', level: 'industry' }, { code: 'H', name: 'Homes', level: 'industry' }], '2025-01-07')
    assert.deepEqual(stored.rows.map(r => r.far), [{ p_win: 0.2, p_lose: 0.6 }, null])
    assert.ok(controlSchema().properties.industries.items.required.includes('far_win'))
})

test('testScope: no date, the test has not started and everything is the trial; with one, only what came from it counts', () => {
    const runs = [{ as_of: '2026-11-23' }, { as_of: '2026-12-05' }], control = [{ as_of: '2026-11-24' }, { as_of: '2026-12-05' }]
    assert.deepEqual(testScope(runs, control, null), { started_on: null, runs, control })
    assert.equal(testScope(runs, control, 'soon').started_on, null)
    const s = testScope(runs, control, '2026-12-05')
    assert.deepEqual([s.started_on, s.runs.length, s.control.length], ['2026-12-05', 1, 1])
    assert.equal(verdict({ all: { questions: 500, brier: 0.1, equal_odds: 0.25, calibration: [{ n: 20, said: 0.5, happened: 0.5 }] } }, { n: 9, mean: 1, t: 9, first_half: 1, second_half: 1 }, null, '2030-01-01').pass, false)
})

test('sides: a date with one side only is graded on it; the two apart, and together; spreads still needs both', () => {
    const dates = Array.from({ length: 30 }, (_, i) => `2025-01-${String(i + 1).padStart(2, '0')}`)
    const mk = (id, end) => ({ _id: id, dates, levels: dates.map((_, i) => (i > 5 ? end : 100)) })
    const index = [mk('industry:L', 112), mk('industry:S', 88), ...Array.from({ length: 10 }, (_, i) => mk(`industry:f${i}`, 100))]
    const only = (long, short) => [{ as_of: '2025-01-03', long, short }]
    near(sides(only(['industry:L'], []), index, 10)[0].long, 0.12)
    assert.equal(sides(only(['industry:L'], []), index, 10)[0].short, null)
    near(sides(only([], ['industry:S']), index, 10)[0].short, 0.12)
    assert.equal(sides(only([], []), index, 10).length, 0)
    assert.equal(spreads(only(['industry:L'], []), index, 10).length, 0)
    near(spreads(only(['industry:L'], ['industry:S']), index, 10)[0].spread, 0.24)
    const x = sideSummary([{ long: 0.1, short: null }, { long: 0.1, short: 0.3 }])
    assert.deepEqual([x.n, x.long.n, x.short.n], [2, 2, 1])
    near(x.mean, 0.15)
})
