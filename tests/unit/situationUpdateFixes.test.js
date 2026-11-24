import { test } from 'node:test'
import assert from 'node:assert/strict'

import { numbered, applyAnswer, runUpdate, withDescendants, refreshSections, isCodeItem, _setIO } from '../../services/situation/update.js'
import { checkBundle } from '../../services/situation/store.js'
import { anchorFor } from '../../services/situation/propagate.js'

// The missing-outcomes review never reaches the model from a test.
_setIO({ outcomes: async () => ({ ok: true, data: { changes: [] }, list: [], cost_usd: 0 }) })

// The code review's fixes (2026-11-23, Roy: "fix all").

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
const newQuestion = (over = {}) => ({ question: 'Minerals?', tree: 'tariffs_trade', impact: 'high', uncertainty: 'high', why: '', resolve_by: '2025-06-30', lag_days: { min: 0, max: 9 },
    options: [{ key: 'a', label: 'A', signpost: 's' }, { key: 'b', label: 'B', signpost: 's' }], probabilities: [{ option: 'a', value: 0.5 }, { option: 'b', value: 0.5 }], ...over })

test('withDescendants: a dropped parent takes every node under it, however far down', () => {
    const ns = [node('p', { a: 0.5, b: 0.5 }), node('c', { x: 0.5, y: 0.5 }, { given: { node_id: 'p', option: 'a' } }), node('g', { x: 0.5, y: 0.5 }, { given: { node_id: 'c', option: 'x' } }), node('o', { a: 0.5, b: 0.5 })]
    assert.deepEqual(withDescendants(ns, ['p']).sort(), ['c', 'g', 'p'])
})

test('applyAnswer: a node resolved earlier in the same answer is not moved; empty signposts and evidence are said', () => {
    const { nodes } = network()
    const r = applyAnswer({ events: [
        ev({ decision: 'resolves', node: 3, resolution: { option: 'rises', evidence: '' }, summary: 'CPI 4%' }),
        ev({ decision: 'moves_option', node: 3, probabilities: [{ option: 'falls', value: 0.7 }, { option: 'stuck', value: 0.2 }, { option: 'rises', value: 0.1 }] }),
        ev({ decision: 'new_option', node: 1, new_option: { key: 'paused', label: 'Paused', signpost: '' }, probabilities: [{ option: 'threats', value: 0.85 }, { option: 'china', value: 0.05 }, { option: 'all', value: 0.05 }, { option: 'paused', value: 0.05 }] }),
    ], signposts_fired: [], due: [] }, numbered(nodes), nodes, '2025-02-04')
    const infl = r.nodes.find(n => n.node_id === 'infl')
    assert.deepEqual(infl.options.map(o => o.p), [0, 0, 1], 'stays 100% on what happened')
    assert.equal(infl.resolved.evidence, 'CPI 4%', 'empty evidence falls back to the summary')
    assert.equal(r.decisions[1].applied, false)
    assert.match(r.nodes.find(n => n.node_id === 'broad').options.find(o => o.key === 'paused').signpost, /No signpost was given/)
})

test('applyAnswer survives impossible dates from the model ("2027-06-00", "2026-13-01")', () => {
    const { nodes } = network()
    const r = applyAnswer({ events: [ev({ decision: 'new_question', new_question: newQuestion({ resolve_by: '2027-06-00' }) })],
        signposts_fired: [], due: [{ node: 1, resolved: false, option: null, evidence: '', new_resolve_by: '2026-13-01' }] }, numbered(nodes), nodes, '2025-02-04')
    assert.equal(r.created.length, 1)
    assert.equal(r.nodes.find(n => n.node_id === r.created[0]).resolve_by, null)
    assert.equal(r.nodes.find(n => n.node_id === 'broad').resolve_by, '2025-02-18', 'a bad date → two weeks on')
})

test('refreshSections: the code items replaced, everything the model wrote kept', () => {
    const prev = {
        regime: [{ text: 'old 10y', source: 'FRED DGS10', tag: 'fact' }, { text: 'reading', source: 'the model reading', tag: 'reading' }],
        money: [{ text: 'capex', source: 'engine industry_metrics (capex)', tag: 'fact' }, { text: 'Meta $65B', source: 'FMP news, 2025-01-24: Meta', tag: 'fact' }],
        policy: [{ text: 'p', source: 'AP', tag: 'fact' }],
    }
    const out = refreshSections(prev, { regime: [{ text: 'new 10y', source: 'FRED DGS10', tag: 'fact' }], money: [{ text: 'capex new', source: 'engine industry_metrics (capex)', tag: 'fact' }] })
    assert.deepEqual(out.regime.map(i => i.text), ['new 10y', 'reading'])
    assert.deepEqual(out.money.map(i => i.text), ['capex new', 'Meta $65B'])
    assert.deepEqual(out.policy, prev.policy)
    assert.equal(isCodeItem({ source: 'FMP news, 2025-01-24: x' }), false)
    assert.equal(isCodeItem({ source: 'FMP daily bars ^IXIC' }), true)
})

function base(record) {
    const { nodes, links } = network()
    return {
        latest: async () => ({ run_id: 'run_1', as_of: '2025-01-07' }),
        read: async () => ({ run: { run_id: 'run_1' }, state: { as_of: '2025-01-07', sections: { regime: [{ text: 'old', value: null, as_of: '2025-01-06', source: 'FRED DGS10', tag: 'fact' }], policy: [], money: [], stories: [], prices: [], calendar: [] }, articles: [] },
            nodes, links, dropped: { considered: 3, open: 2, settled: 1, dropped: [] }, industries: [{ code: '15104030', name: 'Gold', level: 'sub_industry', p_win: 0.2, p_lose: 0.1 }] }),
        news: async () => ({ articles: [], gaps: [] }), payer: async () => null, system: () => 'S',
        call: async () => ({ data: { events: [ev({ decision: 'resolves', node: 2, resolution: { option: 'yes', evidence: 'signed' } }), ev({ decision: 'new_question', new_question: newQuestion() })], signposts_fired: [], due: [] } }),
        exposures: async (names) => { record.names = names; return { industries: [{ basket: 'sub_industry:15104030', level: 'sub_industry', code: '15104030', name: names.get('sub_industry:15104030') ?? '15104030', sens: null, reactions: [] }] } },
        map: async () => ({ ok: true, effects: new Map(), cost_usd: 0.1 }),
        links: async (ns, ids) => ({ ok: true, links: [{ link_id: 'Lnew', from: { node_id: ids[0], option: 'a' }, to: { node_id: 'infl', option: 'rises' }, shift: 0.4, live: true }], cost_usd: 0.05 }),
        data: async () => ({ sections: { regime: [{ text: 'new 10y', value: 4.7, as_of: '2025-02-03', source: 'FRED DGS10', tag: 'fact' }], prices: [], money: [], calendar: [] }, gaps: [] }),
        save: async (b) => { record.saved = b; record.order.push('saved'); const c = checkBundle(b); return c.ok ? { ok: true, run_id: 'run_2' } : c },
        grade: async (id) => { record.order.push(`graded ${id}`) },
    }
}

test('runUpdate: names kept for the mapping, new questions linked, the weekly data refreshed, graded only after the save', async () => {
    const rec = { order: [] }
    _setIO(base(rec))
    const r = await runUpdate({ asOf: '2025-02-04' })
    assert.equal(r.ok, true, r.reason)
    assert.equal(rec.names.get('sub_industry:15104030'), 'Gold', 'the mapping keeps the names')
    assert.equal(rec.saved.industries.find(i => i.code === '15104030')?.name ?? 'Gold', 'Gold')
    assert.ok(rec.saved.links.some(l => l.link_id === 'Lnew'), 'the new question is linked in')
    assert.equal(r.stats.links_added, 1)
    assert.deepEqual(rec.saved.state.sections.regime.map(i => i.text), ['new 10y'], 'the weekly refreshed the code data')
    assert.deepEqual(rec.order, ['saved', 'graded q1'], 'graded after the save')
})

test('runUpdate: an event update carries the state as it was (no data refresh)', async () => {
    const rec = { order: [] }
    _setIO(base(rec))
    const r = await runUpdate({ kind: 'event', trigger: 'x', asOf: '2025-02-04' })
    assert.equal(r.ok, true, r.reason)
    assert.deepEqual(rec.saved.state.sections.regime.map(i => i.text), ['old'])
})

test('runUpdate: if the network moved while it ran (an override), nothing is saved and nothing graded', async () => {
    const rec = { order: [] }
    let calls = 0
    _setIO({ ...base(rec), latest: async () => ({ run_id: calls++ === 0 ? 'run_1' : 'run_override', as_of: '2025-01-08' }) })
    const r = await runUpdate({ asOf: '2025-02-04' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /changed while the update ran/)
    assert.deepEqual(rec.order, [])
})

test('runUpdate: the cap drops a node AND its children, and the run still saves', async () => {
    const rec = { order: [] }
    const many = Array.from({ length: 20 }, (_, i) => node(`o${i}`, { a: 0.5, b: 0.5 }, { impact: 'high' }))
    const weak = node('weak', { a: 0.75, b: 0.25 }, { impact: 'low' })
    const child = node('child', { x: 0.5, y: 0.5 }, { given: { node_id: 'weak', option: 'a' }, impact: 'high' })
    const all = [...many, weak, child]
    _setIO({ ...base(rec), read: async () => ({ run: { run_id: 'run_1' }, state: null, nodes: all, links: [], dropped: { considered: 22, open: 22, settled: 0, dropped: [] }, industries: [] }),
        call: async () => ({ data: { events: [], signposts_fired: [], due: [] } }) })
    const r = await runUpdate({ kind: 'event', trigger: 'x', asOf: '2025-02-04' })
    assert.equal(r.ok, true, r.reason)
    assert.ok(!rec.saved.nodes.some(n => n.node_id === 'weak' || n.node_id === 'child'))
    assert.ok(rec.saved.dropped.dropped.some(d => d.question === 'Q child?'))
})
