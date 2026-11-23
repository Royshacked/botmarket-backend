import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reach, marginal, pathProbability, treePaths, resolve, anchorFor, recompute, propagate, split, MAX_ROUNDS } from '../../services/situation/propagate.js'

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`)
const node = (node_id, opts, given = null) => ({ node_id, tree: 'T1', question: node_id, status: 'live', given, anchor: null,
    options: Object.entries(opts).map(([key, p]) => ({ key, label: key, p })) })

// The design's tariff tree (§5, the end-of-2024 illustration).
const tariffTree = () => [
    node('q1', { yes: 0.85, no: 0.15 }),
    node('broad', { threats: 0.30, china: 0.45, all: 0.25 }, { node_id: 'q1', option: 'yes' }),
    node('china_ret', { yes: 0.80, no: 0.20 }, { node_id: 'broad', option: 'china' }),
    node('infl', { yes: 0.40, no: 0.60 }, { node_id: 'china_ret', option: 'yes' }),
    node('broad_ret', { yes: 0.75, no: 0.25 }, { node_id: 'broad', option: 'all' }),
    node('scare', { yes: 0.55, no: 0.45 }, { node_id: 'broad_ret', option: 'yes' }),
]

test('the 9% path: 0.85 × 0.25 × 0.75 × 0.55', () => {
    const p = pathProbability(tariffTree(), [{ node_id: 'q1', option: 'yes' }, { node_id: 'broad', option: 'all' }, { node_id: 'broad_ret', option: 'yes' }, { node_id: 'scare', option: 'yes' }])
    near(p, 0.85 * 0.25 * 0.75 * 0.55)
    assert.equal(pathProbability(tariffTree(), [{ node_id: 'q1', option: 'yes' }, { node_id: 'scare', option: 'yes' }]), null, 'not a chain')
})

test('reach and marginal follow the branches above', () => {
    const n = tariffTree()
    near(reach(n, 'scare'), 0.85 * 0.25 * 0.75)
    near(marginal(n, 'scare', 'yes'), 0.85 * 0.25 * 0.75 * 0.55)
    assert.equal(reach(n, 'q1'), 1)
})

test('the tree has the eight end points of the design, and they sum to 100%', () => {
    const paths = treePaths(tariffTree(), 'q1')
    assert.equal(paths.length, 8)
    near(paths.reduce((s, x) => s + x.p, 0), 1)
    const nine = paths.find(x => x.steps.map(s => s.option).join('>') === 'yes>all>yes>yes')
    near(nine.p, 0.0877, 1e-4)
})

test('resolving a step makes it 100% and the paths after it grow: 9% → 41% once tariffs are broad', () => {
    let n = resolve(tariffTree(), 'q1', 'yes', { evidence: 'orders signed', on: '2025-02-01' })
    n = resolve(n, 'broad', 'all')
    near(pathProbability(n, [{ node_id: 'q1', option: 'yes' }, { node_id: 'broad', option: 'all' }, { node_id: 'broad_ret', option: 'yes' }, { node_id: 'scare', option: 'yes' }]), 0.75 * 0.55)
    assert.equal(reach(n, 'china_ret'), 0, 'the China branch died')
    assert.equal(n.find(x => x.node_id === 'q1').status, 'resolved')
    near(treePaths(n, 'q1').reduce((s, x) => s + x.p, 0), 1)
})

// Links: an Iran strike pushes "inflation rises" (link 6 of the illustration).
const linked = () => {
    const nodes = [node('iran', { strike: 0.2, standoff: 0.65, deal: 0.15 }), node('inflation', { falls: 0.35, stuck: 0.45, rises: 0.20 })]
    const links = [{ link_id: 'L6', from: { node_id: 'iran', option: 'strike' }, to: { node_id: 'inflation', option: 'rises' }, shift: 1.5, live: true }]
    nodes[1] = { ...nodes[1], anchor: anchorFor(nodes, links, 'inflation') }
    return { nodes, links }
}

test('a link moves its target only by how much its source moved since the anchor (no double counting)', () => {
    const { nodes, links } = linked()
    const still = propagate(nodes, links)
    near(still.nodes[1].options.find(o => o.key === 'rises').p, 0.20, 1e-12)
    assert.equal(still.changes.length, 0)
    const moved = nodes.map(n => (n.node_id === 'iran' ? { ...n, options: [{ key: 'strike', label: 's', p: 0.6 }, { key: 'standoff', label: 'x', p: 0.3 }, { key: 'deal', label: 'd', p: 0.1 }] } : n))
    const r = propagate(moved, links)
    const rises = r.nodes[1].options.find(o => o.key === 'rises').p
    const expected = 0.2 * Math.exp(1.5 * 0.4) / (0.35 + 0.45 + 0.2 * Math.exp(1.5 * 0.4))
    near(rises, expected)
    near(r.nodes[1].options.reduce((s, o) => s + o.p, 0), 1)
    assert.ok(r.changes.some(c => c.node_id === 'inflation' && c.option === 'rises'))
})

test('a resolved source pushes fully; stacked links never leave (0, 1)', () => {
    const { nodes, links } = linked()
    const struck = resolve(nodes, 'iran', 'strike')
    const many = Array.from({ length: 6 }, (_, i) => ({ ...links[0], link_id: `L${i}`, shift: 3 }))
    const anchored = struck.map(n => (n.node_id === 'inflation' ? { ...n, anchor: { p: { falls: 0.35, stuck: 0.45, rises: 0.2 }, src: Object.fromEntries(many.map(l => [l.link_id, 0.2])) } } : n))
    const r = propagate(anchored, many)
    const p = r.nodes[1].options.find(o => o.key === 'rises').p
    assert.ok(p > 0.99 && p < 1)
})

test('a loop settles; a runaway loop stops at the round cap', () => {
    const a = node('a', { up: 0.5, down: 0.5 }), b = node('b', { up: 0.5, down: 0.5 })
    const loop = [
        { link_id: 'ab', from: { node_id: 'a', option: 'up' }, to: { node_id: 'b', option: 'up' }, shift: 0.5 },
        { link_id: 'ba', from: { node_id: 'b', option: 'up' }, to: { node_id: 'a', option: 'up' }, shift: 0.5 },
    ]
    const anchored = [{ ...a, anchor: { p: { up: 0.5, down: 0.5 }, src: { ba: 0.4 } } }, { ...b, anchor: { p: { up: 0.5, down: 0.5 }, src: { ab: 0.5 } } }]
    const r = propagate(anchored, loop)
    assert.equal(r.settled, true)
    assert.ok(r.rounds > 1 && r.rounds < MAX_ROUNDS)
    const wild = loop.map(l => ({ ...l, shift: 3 }))
    const w = propagate(anchored, wild, { settleBy: 1e-12, maxRounds: 4 })
    assert.equal(w.rounds, 4)
    assert.equal(w.settled, false)
})

test('a node without an anchor, or resolved, is left as it is', () => {
    const n = node('x', { a: 0.5, b: 0.5 })
    assert.equal(recompute(n, [], new Map()), n)
    const r = { ...n, status: 'resolved', anchor: { p: { a: 0.5, b: 0.5 }, src: {} } }
    assert.equal(recompute(r, [], new Map()), r)
})

test('split: the parts inherit the node and its links; the original is marked split', () => {
    const nodes = [node('broad', { threats: 0.3, china: 0.45, all: 0.25 }), node('infl', { yes: 0.4, no: 0.6 })]
    const links = [{ link_id: 'L1', from: { node_id: 'broad', option: 'all' }, to: { node_id: 'infl', option: 'yes' }, shift: 0.8 }]
    const parts = [
        { node_id: 'broad_china', question: 'China tariffs?', options: [{ key: 'all', label: 'real', p: 1 }, { key: 'threats', label: 'paused', p: 0 }] },
        { node_id: 'broad_neighbours', question: 'Neighbour tariffs?', options: [{ key: 'all', label: 'real', p: 0.3 }, { key: 'threats', label: 'paused', p: 0.7 }] },
    ]
    const r = split(nodes, links, 'broad', parts)
    assert.equal(r.nodes.find(x => x.node_id === 'broad').status, 'split')
    assert.deepEqual(r.nodes.filter(x => x.split_from === 'broad').map(x => x.node_id), ['broad_china', 'broad_neighbours'])
    assert.deepEqual(r.links.map(l => l.from.node_id), ['broad_china', 'broad_neighbours'])
})
