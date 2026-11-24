import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatSummary, formatIndustry, formatQuestion, formatScorecard, makeSituationHandlers } from '../../services/tools/situation.tools.js'
import { toolsForUser } from '../../services/agents/axl.agent.service.js'

const run = {
    run: { kind: 'weekly', as_of: '2025-01-14', stats: { woken: [{ question: 'Hormuz disrupted?', label: 'Disrupted', p: 0.25 }], decisions: [{ decision: 'moves_option', applied: true, summary: 'Russia oil sanctions' }] } },
    nodes: [
        { node_id: 'n1', question: 'Does the US strike Iran by end of Q1?', status: 'live', kind: 'open', set_by: 'llm', resolve_by: '2025-03-31', reasoning: 'r',
            options: [{ key: 'strikes', label: 'Strikes', p: 0.35, effects: [{ code: 'OIL', direction: 'up', bucket: 'large', why: 'oil spikes' }] }, { key: 'standoff', label: 'Standoff', p: 0.65, effects: [] }] },
        { node_id: 'n2', question: 'Hormuz disrupted?', status: 'live', kind: 'settled', set_by: 'llm', options: [{ key: 'yes', label: 'Disrupted', p: 0.2, dormant: true, signpost: 'tankers hit' }, { key: 'no', label: 'Normal', p: 0.8 }] },
    ],
    links: [{ from: { node_id: 'n1', option: 'strikes' }, to: { node_id: 'n2', option: 'yes' }, shift: 0.8 }],
    industries: [{ code: 'OIL', name: 'Oil & Gas Exploration', p_win: 0.62, p_lose: 0.1, bucket: 'medium', agreement: 0.86, paths: [{ node_id: 'n1', option: 'strikes', question: 'Does the US strike Iran by end of Q1?', label: 'Strikes', weight: 1.05 }] }],
}

test('summary: the calls, the early warnings, open and settled questions, the last decisions; untested said', () => {
    const s = formatSummary(run)
    assert.match(s, /A forward test, untested/)
    assert.match(s, /INDUSTRY CALLS .*Oil & Gas Exploration wins 62%/)
    assert.match(s, /EARLY WARNINGS .*Hormuz disrupted\? → Disrupted \(25%\)/)
    assert.match(s, /- Does the US strike Iran by end of Q1\? — Strikes 35% \/ Standoff 65%/)
    assert.match(s, /SETTLED \(1\): Hormuz disrupted\? — Disrupted 20% \(dormant\) \/ Normal 80%/)
    assert.match(s, /moves option: Russia oil sanctions/)
})

test('industry: its chances and the branches behind, with why; an unknown name lists what is scored', () => {
    const s = formatIndustry(run, 'oil')
    assert.match(s, /wins 62%, loses 10%/)
    assert.match(s, /"Does the US strike Iran by end of Q1\?" \(resolves by 2025-03-31\) → Strikes: helps — oil spikes/)
    assert.match(s, /size medium \(how big the average push[\s\S]*not a position size\)/)
    assert.match(s, /HORIZON: there is no single one[\s\S]*3 and 6 months/)
    assert.match(formatIndustry(run, 'banks'), /scores no industry matching "banks"/)
})

test('question: by words, with links both ways and dormant signposts', () => {
    const s = formatQuestion(run, 'hormuz')
    assert.match(s, /SIGNPOST for "Disrupted": tankers hit/)
    assert.match(s, /MOVED BY: Does the US strike Iran by end of Q1\? → strikes raises yes/)
    assert.match(formatQuestion(run, 'strike iran'), /MOVES: Strikes raises "Hormuz disrupted\?" → yes/)
})

test('scorecard: the checks against the declared rule', () => {
    const s = formatScorecard({ started_on: '2026-11-23', runs: 3, nodes: { all: { questions: 0, brier: null, equal_odds: null } },
        industries: { m6: { n: 0, mean: null, t: null } }, control: { m6: { mean: null } },
        verdict: { months: 0, pass: false, checks: { '1_brier_beats_equal_odds': false, '5_twelve_months': false } } })
    assert.match(s, /FORWARD TEST since 2026-11-23/)
    assert.match(s, /1 brier beats equal odds ✗/)
    assert.match(s, /Not passed\./)
})

test('the tool exists only for the allow-list: in the tool list, and in the handler', async () => {
    const keep = process.env.SITUATION_USERS
    try {
        process.env.SITUATION_USERS = 'roy,marce'
        assert.ok(toolsForUser('roy').some(t => t.name === 'get_situation'))
        assert.ok(toolsForUser('marce', { specialist: false }).some(t => t.name === 'get_situation'))
        assert.ok(!toolsForUser('someone').some(t => t.name === 'get_situation'))
        assert.ok(!toolsForUser('roy', { specialist: false }).some(t => t.name === 'ask_specialist'))
        const deps = { latest: async () => ({ run_id: 'r' }), read: async () => run, scorecard: async () => null }
        assert.equal(await makeSituationHandlers('someone', deps).get_situation({}), 'Not available.')
        assert.match(await makeSituationHandlers('marce', deps).get_situation({ view: 'industry', name: 'oil' }), /wins 62%/)
        assert.match(await makeSituationHandlers('roy', { ...deps, latest: async () => null }).get_situation({}), /not been built/)
    } finally { if (keep === undefined) delete process.env.SITUATION_USERS; else process.env.SITUATION_USERS = keep }
})
