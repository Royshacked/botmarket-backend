import { test } from 'node:test'
import assert from 'node:assert/strict'

import { updateSchema, numbered, updatePrompt, fitProbabilities, reviewItems, applyAnswer, runUpdate, _setIO, REVIEW_MOVE } from '../../services/situation/update.js'
import { checkBundle } from '../../services/situation/store.js'
import { holdCaps } from '../../services/situation/layers.js'
import { anchorFor } from '../../services/situation/propagate.js'

// The missing-outcomes review never reaches the model from a test.
_setIO({ outcomes: async () => ({ ok: true, data: { changes: [] }, list: [], cost_usd: 0 }), check: async (items) => ({ ok: true, checks: items.map(() => ({ fits: true, unforeseen: null })), cost_usd: 0 }) })

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`)
const node = (node_id, opts, over = {}) => ({
    node_id, tree: 'tariffs_trade', question: `Q ${node_id}?`, status: 'live', kind: 'open', impact: 'high', given: null, anchor: null, review: null, woken: [],
    resolve_by: '2025-03-31', options: Object.entries(opts).map(([key, p]) => ({ key, label: key, p, signpost: `sign ${key}`, dormant: false, effects: [] })), ...over,
})
const ev = (over) => ({ articles: [1], summary: 's', reasoning: 'r', decision: 'none', node: null, probabilities: [], new_option: null, resolution: null, new_question: null, outside: null, ...over })

const network = () => {
    const nodes = [
        node('broad', { threats: 0.3, china: 0.45, all: 0.25 }),
        node('q1', { yes: 0.85, no: 0.15 }, { kind: 'settled', options: [{ key: 'yes', label: 'yes', p: 0.85, signpost: 's', dormant: false, effects: [] }, { key: 'no', label: 'no', p: 0.15, signpost: 'no order by 1 Feb', dormant: true, effects: [] }] }),
        node('infl', { falls: 0.35, stuck: 0.45, rises: 0.2 }),
    ]
    const links = [{ link_id: 'L1', from: { node_id: 'broad', option: 'all' }, to: { node_id: 'infl', option: 'rises' }, shift: 1, live: true }]
    return { nodes: nodes.map(n => ({ ...n, anchor: anchorFor(nodes, links, n.node_id, '2025-01-07') })), links }
}

test('the schema is strict; the prompt numbers live nodes, marks DUE and dormant signposts', () => {
    assert.equal(updateSchema().properties.events.items.additionalProperties, false)
    const { nodes } = network()
    const list = numbered([...nodes, node('gone', { a: 0.5, b: 0.5 }, { status: 'resolved' })])
    assert.equal(list.length, 3)
    const p = updatePrompt('2025-04-01', '2025-01-07', list, [])
    assert.match(p, /1\. \[tariffs_trade\] Q broad\? \(resolve by 2025-03-31\) DUE/)
    assert.match(p, /no = no 15% \(dormant; signpost: no order by 1 Feb\)/)
})

test('fitProbabilities fits a list to the keys and renormalises; nothing positive is null', () => {
    assert.deepEqual(fitProbabilities(['a', 'b'], [{ option: 'a', value: 3 }, { option: 'b', value: 1 }, { option: 'c', value: 9 }]), [0.75, 0.25])
    assert.equal(fitProbabilities(['a'], []), null)
})

test('holdCaps (the macro layer) drops the lowest impact × uncertainty open nodes; settled ones never count', () => {
    const ns = [node('a', { x: 0.5, y: 0.5 }), node('b', { x: 0.7, y: 0.3 }, { impact: 'low' }), node('c', { x: 0.9, y: 0.1 }, { kind: 'settled' })]
    assert.deepEqual([...holdCaps(ns, { macro: 1 }).keys()], ['b'])
    assert.equal(holdCaps(ns, { macro: 5 }).size, 0)
})

test('reviewItems: a move over 10 points; drift since the last review; new, woken and resolved', () => {
    const prev = [node('a', { x: 0.5, y: 0.5 }), node('b', { x: 0.5, y: 0.5 }, { review: { on: '2025-01-01', p: { x: 0.3, y: 0.7 } } })]
    const now = [node('a', { x: 0.65, y: 0.35 }), node('b', { x: 0.45, y: 0.55 }, { review: { on: '2025-01-01', p: { x: 0.3, y: 0.7 } } })]
    const items = reviewItems(prev, now, { created: ['n'], woken: [{ node_id: 'q1', option: 'no' }], resolved: [{ node_id: 'z', option: 'yes' }] })
    assert.deepEqual(items.map(i => `${i.node_id}:${i.why}`), ['a:moved', 'b:drift', 'n:new', 'q1:woken', 'z:resolved'])
    assert.equal(REVIEW_MOVE, 0.1)
})

test('applyAnswer: every decision kind, signposts and due questions', () => {
    const { nodes } = network()
    const list = numbered(nodes)
    const r = applyAnswer({
        events: [
            ev({ decision: 'moves_option', node: 3, probabilities: [{ option: 'falls', value: 0.25 }, { option: 'stuck', value: 0.45 }, { option: 'rises', value: 0.3 }] }),
            ev({ decision: 'new_option', node: 1, new_option: { key: 'imposed_then_paused', label: 'Imposed, then paused', signpost: 'a pause' }, probabilities: [{ option: 'threats', value: 0.2 }, { option: 'china', value: 0.25 }, { option: 'all', value: 0.1 }, { option: 'imposed_then_paused', value: 0.45 }] }),
            ev({ decision: 'resolves', node: 2, resolution: { option: 'yes', evidence: 'Orders signed 1 Feb' } }),
            ev({ decision: 'new_question', new_question: { question: 'Does China use critical minerals as a weapon?', tree: 'tariffs_trade', impact: 'high', uncertainty: 'high', why: 'w', resolve_by: '2025-06-30', lag_days: { min: 0, max: 60 },
                options: [{ key: 'limited', label: 'Limited', signpost: 's' }, { key: 'escalating', label: 'Escalating', signpost: 's' }, { key: 'full_ban', label: 'Full ban', signpost: 's' }],
                probabilities: [{ option: 'limited', value: 0.5 }, { option: 'escalating', value: 0.4 }, { option: 'full_ban', value: 0.1 }] } }),
            ev({ decision: 'outside', outside: { text: 'LA wildfires', industries: ['Property & Casualty Insurance'] } }),
            ev({ decision: 'none' }),
            ev({ decision: 'moves_option', node: 99, probabilities: [] }),
        ],
        signposts_fired: [{ node: 2, option: 'no', evidence: 'no order', articles: [2] }],   // q1 resolves above
        due: [{ node: 3, resolved: false, option: null, evidence: 'still open', new_resolve_by: '2025-06-30' }],
    }, list, nodes, '2025-02-04')
    const by = (id) => r.nodes.find(n => n.node_id === id)
    near(by('infl').options.find(o => o.key === 'rises').p, 0.3)
    assert.deepEqual(by('broad').options.map(o => o.key), ['threats', 'china', 'all', 'imposed_then_paused'])
    assert.equal(by('q1').status, 'resolved')
    assert.equal(r.created.length, 1)
    assert.equal(r.outside.length, 1)
    assert.deepEqual([...r.needMap].length, 2, 'the new option and the new question are mapped')
    assert.equal(r.decisions.length, 7)
    assert.equal(r.decisions.at(-1).applied, false, 'an unknown node is logged, not applied')
    assert.equal(r.woken.length, 0, 'q1 resolved first: a resolved node does not wake')
    assert.equal(by('infl').resolve_by, '2025-06-30')
})

test('applyAnswer: a fired signpost on a dormant branch wakes it once', () => {
    const { nodes } = network()
    const list = numbered(nodes)
    const data = { events: [], signposts_fired: [{ node: 2, option: 'no', evidence: 'inauguration passed, no order', articles: [1] }, { node: 1, option: 'all', evidence: 'not dormant', articles: [1] }], due: [] }
    const r = applyAnswer(data, list, nodes, '2025-01-21')
    assert.deepEqual(r.woken.map(w => w.node_id), ['q1'])
    assert.equal(r.nodes.find(n => n.node_id === 'q1').woken[0].option, 'no')
    const again = applyAnswer(data, numbered(r.nodes), r.nodes, '2025-01-28')
    assert.equal(again.woken.length, 0)
})

test('runUpdate: from the latest run to a saved run that passes every check, with the review list and grading', async () => {
    const { nodes, links } = network()
    let saved = null
    const graded = []
    _setIO({
        latest: async () => ({ run_id: 'run_1', as_of: '2025-01-07' }),
        read: async () => ({ run: { run_id: 'run_1' }, state: { as_of: '2025-01-07', sections: { regime: [], policy: [], money: [], stories: [], prices: [], calendar: [] }, articles: [] },
            nodes, links, dropped: { considered: 3, open: 2, settled: 1, dropped: [] }, industries: [{ code: 'G', name: 'Gold', level: 'industry', p_win: 0.2, p_lose: 0.1 }] }),
        news: async () => ({ articles: [{ url: 'u', title: 'Tariffs signed', source: 'AP', published_at: '2025-02-01T22:00:00Z', text: '' }], gaps: [] }),
        payer: async () => null, system: () => 'S',
        call: async (a) => { a.onUsage({ input_tokens: 1000, output_tokens: 500 }, 'claude-opus-5-5'); return { data: {
            events: [ev({ decision: 'resolves', node: 2, resolution: { option: 'yes', evidence: 'Orders signed' } }), ev({ decision: 'moves_option', node: 1, probabilities: [{ option: 'threats', value: 0.2 }, { option: 'china', value: 0.3 }, { option: 'all', value: 0.5 }] })],
            signposts_fired: [], due: [] } } },
        exposures: async () => ({ industries: [] }), map: async () => ({ ok: true, effects: new Map(), cost_usd: 0 }),
        // No live data or model call from a test: the weekly path's data refresh and rewrite are stubbed.
        data: async () => ({ sections: null, gaps: [] }), rewrite: async () => ({ ok: false, reason: 'stub', cost_usd: 0 }), sectorsOn: () => false,
        save: async (b) => { saved = b; const c = checkBundle(b); return c.ok ? { ok: true, run_id: 'run_2' } : c },
        grade: async (id, opt) => { graded.push(`${id}:${opt}`); return 1 },
    })
    const r = await runUpdate({ asOf: '2025-02-04' })
    assert.equal(r.ok, true, r.reason)
    assert.deepEqual(graded, ['q1:yes'])
    const infl = saved.nodes.find(n => n.node_id === 'infl')
    assert.ok(infl.options.find(o => o.key === 'rises').p > 0.2, '"broad" rose, so the link lifted "inflation rises"')
    assert.ok(r.stats.review.some(x => x.node_id === 'broad' && x.why === 'moved'))
    assert.ok(r.stats.review.some(x => x.node_id === 'q1' && x.why === 'resolved'))
    assert.equal(saved.dropped.resolved, 1)
    assert.ok(saved.forecasts.every(f => f.node_id === 'broad'), 'only re-judged numbers are logged')
    assert.deepEqual(saved.nodes.find(n => n.node_id === 'broad').review.p, { threats: 0.2, china: 0.3, all: 0.5 }, 'silence = accept: the card resets the baseline')
})

test('runUpdate: no run yet, or a failed call, is a clear failure', async () => {
    _setIO({ latest: async () => null })
    assert.match((await runUpdate()).reason, /build first/)
    _setIO({ latest: async () => ({ run_id: 'r', as_of: '2025-01-07' }), call: async () => ({ data: null, stopReason: 'max_tokens' }) })
    assert.match((await runUpdate({ asOf: '2025-01-14' })).reason, /max_tokens/)
})
