import { test } from 'node:test'
import assert from 'node:assert/strict'

import { networkSchema, networkPrompt, combineRuns, assemble, uncertainty, buildNetwork, _setIO, OPEN_CAP, STRENGTH_SHIFT, NO_SIGNPOST } from '../../services/situation/network.js'
import { checkBundle } from '../../services/situation/store.js'
import { propagate } from '../../services/situation/propagate.js'

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`)
const Q = (question, keys, over = {}) => ({ question, tree: 'tariffs_trade', options: keys.map(k => ({ key: k, label: k })), impact: 'high', uncertainty: 'high', why: '', ...over })
const ans = (question, probs, over = {}) => ({
    question, reasoning: 'r', base_rate: null, confidence: 'high', lag_days: { min: 0, max: 30 }, resolve_by: '2025-03-31',
    probabilities: Object.entries(probs).map(([option, value]) => ({ option, value })),
    signposts: Object.keys(probs).map(option => ({ option, signpost: `sign of ${option}` })), given: null, duplicate_of: null, ...over,
})
const state = { as_of: '2025-01-07', sections: { regime: [{ as_of: '2025-01-07', tag: 'fact', text: '10y 4.6%' }], policy: [], money: [], stories: [], prices: [], calendar: [] } }

test('the schema is strict; the prompt numbers the questions with their option keys', () => {
    const s = networkSchema()
    assert.equal(s.properties.nodes.items.additionalProperties, false)
    const p = networkPrompt(state, [Q('Tariffs in Q1?', ['yes', 'no'])])
    assert.match(p, /1\. \[tariffs_trade\] Tariffs in Q1\?\n {3}options: yes = yes; no = no/)
    assert.match(p, /- 2025-01-07 \[fact\] 10y 4.6%/)
})

test('uncertainty: 1 for even odds, 0 for certainty', () => {
    near(uncertainty([0.5, 0.5]), 1)
    near(uncertainty([1, 0]), 0)
    assert.ok(uncertainty([0.85, 0.15]) < uncertainty([0.45, 0.55]))
})

test('combineRuns: the median per option, renormalised; spread marks confidence; given and links by majority', () => {
    const qs = [Q('Tariffs in Q1?', ['yes', 'no']), Q('How broad?', ['threats', 'all'])]
    const runs = [
        { nodes: [ans(1, { yes: 0.8, no: 0.2 }), ans(2, { threats: 0.6, all: 0.4 }, { given: { question: 1, option: 'yes' } })], links: [{ from: { question: 2, option: 'all' }, to: { question: 1, option: 'yes' }, direction: 'raises', strength: 'large', lag_days: { min: 0, max: 7 }, why: 'w' }] },
        { nodes: [ans(1, { yes: 0.9, no: 0.1 }), ans(2, { threats: 0.2, all: 0.8 }, { given: { question: 1, option: 'yes' } })], links: [{ from: { question: 2, option: 'all' }, to: { question: 1, option: 'yes' }, direction: 'raises', strength: 'small', lag_days: { min: 0, max: 7 }, why: 'w' }] },
        { nodes: [ans(1, { yes: 0.85, no: 0.15 }), ans(2, { threats: 0.5, all: 0.5 })], links: [] },
    ]
    const c = combineRuns(runs, qs, '2025-01-07')
    near(c.nodes.get(1).p[0], 0.85)
    assert.equal(c.nodes.get(1).confidence, 'high')
    assert.equal(c.nodes.get(2).confidence, 'low', 'runs spread by 0.4')
    assert.deepEqual(c.nodes.get(2).given, { question: 1, option: 'yes' })
    assert.equal(c.links.length, 1, 'named by 2 of 3 runs')
    near(c.links[0].shift, (STRENGTH_SHIFT.large + STRENGTH_SHIFT.small) / 2)
})

test('assemble: duplicates and low impact dropped; the open cap holds; settled nodes are outside it; children follow parents', () => {
    const qs = [Q('Tariffs in Q1?', ['yes', 'no']), Q('How broad?', ['threats', 'all'])]
    for (let i = 0; i < OPEN_CAP + 3; i++) qs.push(Q(`Open question ${i}`, ['a', 'b'], { impact: i < 2 ? 'high' : 'medium' }))
    qs.push(Q('Same as tariffs in Q1?', ['yes', 'no']))
    qs.push(Q('Minor thing?', ['a', 'b'], { impact: 'low' }))
    const n = qs.length
    const runs = [0, 1, 2].map(() => ({
        nodes: qs.map((q, i) => {
            if (i === 0) return ans(1, { yes: 0.85, no: 0.15 })
            if (i === 1) return ans(2, { threats: 0.5, all: 0.5 }, { given: { question: 1, option: 'yes' } })
            if (i === n - 2) return ans(n - 1, { yes: 0.85, no: 0.15 }, { duplicate_of: 1 })
            return ans(i + 1, { a: 0.5 - (i % 5) * 0.05, b: 0.5 + (i % 5) * 0.05 })
        }),
        links: [{ from: { question: 3, option: 'a' }, to: { question: 4, option: 'b' }, direction: 'lowers', strength: 'medium', lag_days: { min: 0, max: 7 }, why: 'w' }],
    }))
    const r = assemble(qs, combineRuns(runs, qs, '2025-01-07'), '2025-01-07')
    const open = r.nodes.filter(x => x.kind === 'open')
    assert.equal(open.length, OPEN_CAP)
    assert.equal(r.nodes.filter(x => x.kind === 'settled').length, 1)
    assert.ok(r.dropped.dropped.some(d => d.reason === 'duplicate' && d.duplicate_of === 'Tariffs in Q1?'))
    assert.ok(r.dropped.dropped.some(d => d.reason === 'low_impact' && d.question === 'Minor thing?'))
    assert.equal(r.dropped.dropped.filter(d => d.reason === 'cap').length, n - 2 - 1 - OPEN_CAP - 1 + 1)
    assert.ok(r.dropped.dropped.filter(d => d.reason === 'cap').every(d => d.flagged))
    const broad = r.nodes.find(x => x.question === 'How broad?')
    assert.equal(broad.given.node_id, r.nodes.find(x => x.question === 'Tariffs in Q1?').node_id)
    assert.ok(r.nodes.every(x => x.anchor && x.anchor.p))
    assert.equal(r.forecasts.length, r.nodes.reduce((s, x) => s + x.options.length, 0))
    const bundle = checkBundle({ run: { kind: 'build', as_of: '2025-01-07' }, nodes: r.nodes, links: r.links, dropped: r.dropped, forecasts: r.forecasts })
    assert.equal(bundle.ok, true, bundle.reason)
    assert.equal(propagate(r.nodes, r.links).changes.length, 0, 'a fresh network is at rest')
})

test('assemble: a node under a dropped branch goes with it; a missing signpost is said, not invented', () => {
    const qs = [Q('Minor parent?', ['a', 'b'], { impact: 'low' }), Q('Child?', ['x', 'y']), Q('Settled?', ['yes', 'no'])]
    const runs = [0, 1].map(() => ({ nodes: [ans(1, { a: 0.5, b: 0.5 }), ans(2, { x: 0.5, y: 0.5 }, { given: { question: 1, option: 'a' } }), ans(3, { yes: 0.9, no: 0.1 }, { signposts: [] })], links: [] }))
    const r = assemble(qs, combineRuns(runs, qs, '2025-01-07'), '2025-01-07')
    assert.deepEqual(r.nodes.map(x => x.question), ['Settled?'])
    assert.match(r.dropped.dropped.find(d => d.question === 'Child?').note, /hangs under question 1/)
    assert.equal(r.nodes[0].options.find(o => o.key === 'no').signpost, NO_SIGNPOST)
})

test('buildNetwork: RUNS calls; fewer than two answers is a failure; the cost is summed', async () => {
    const qs = [Q('Tariffs in Q1?', ['yes', 'no'])]
    let calls = 0
    _setIO({
        payer: async () => 'roy', record: async () => {}, system: () => 'S',
        call: async (args) => { calls++; args.onUsage({ input_tokens: 1000, output_tokens: 100 }, 'claude-opus-5-5'); if (calls === 3) throw new Error('overloaded'); return { data: { nodes: [ans(1, { yes: 0.8, no: 0.2 })], links: [] } } },
    })
    const r = await buildNetwork(state, qs)
    assert.equal(r.ok, true)
    assert.equal(r.runs, 2)
    near(r.cost_usd, 3 * (1000 * 4 + 100 * 20) / 1e6)
    _setIO({ call: async () => ({ data: null }) })
    assert.equal((await buildNetwork(state, qs)).ok, false)
})
