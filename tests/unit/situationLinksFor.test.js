import { test } from 'node:test'
import assert from 'node:assert/strict'

import { linksFor, linksPrompt, _setIO } from '../../services/situation/network.js'
import { formatIndustry } from '../../services/tools/situation.tools.js'

const node = (node_id, opts, over = {}) => ({ node_id, tree: 't', question: `Q ${node_id}?`, status: 'live', options: Object.entries(opts).map(([key, p]) => ({ key, label: key, p })), ...over })

test('linksPrompt marks the new questions', () => {
    const p = linksPrompt([node('a', { x: 0.5, y: 0.5 }), node('b', { x: 0.5, y: 0.5 })], ['b'])
    assert.match(p, /1\. \[Macro · t\] Q a\?/)
    assert.match(p, /2\. NEW \[Macro · t\] Q b\?/)
})

test('linksFor: only links touching a new node, between real options of two live nodes', async () => {
    const nodes = [node('a', { x: 0.5, y: 0.5 }), node('b', { up: 0.5, down: 0.5 }), node('c', { p: 0.5, q: 0.5 }), node('gone', { x: 1 }, { status: 'resolved' })]
    _setIO({ payer: async () => null, call: async (a) => { a.onUsage({ input_tokens: 100, output_tokens: 10 }, 'claude-opus-5-5'); return { data: { links: [
        { from: { question: 1, option: 'x' }, to: { question: 2, option: 'up' }, direction: 'raises', strength: 'medium', lag_days: { min: 0, max: 7 }, why: 'w' },
        { from: { question: 1, option: 'x' }, to: { question: 3, option: 'p' }, direction: 'raises', strength: 'small', lag_days: { min: 0, max: 7 }, why: 'not new' },
        { from: { question: 2, option: 'nope' }, to: { question: 1, option: 'x' }, direction: 'lowers', strength: 'small', lag_days: { min: 0, max: 7 }, why: 'bad option' },
        { from: { question: 2, option: 'down' }, to: { question: 2, option: 'up' }, direction: 'lowers', strength: 'small', lag_days: { min: 0, max: 7 }, why: 'self' },
    ] } } } })
    const r = await linksFor(nodes, ['b'])
    assert.equal(r.ok, true)
    assert.equal(r.links.length, 1)
    assert.deepEqual([r.links[0].from, r.links[0].to, r.links[0].shift], [{ node_id: 'a', option: 'x' }, { node_id: 'b', option: 'up' }, 0.8])
    assert.deepEqual((await linksFor(nodes, [])).links, [], 'no new node, no call')
    _setIO({ call: async () => { throw new Error('overloaded') } })
    assert.equal((await linksFor(nodes, ['b'])).ok, false)
})

test('formatIndustry with no name asks for one rather than matching the first industry', () => {
    const run = { run: { as_of: '2025-01-07' }, nodes: [], industries: [{ code: 'G', name: 'Gold', p_win: 0.7, p_lose: 0.1, paths: [] }] }
    assert.match(formatIndustry(run, ''), /^Name the industry/)
})
