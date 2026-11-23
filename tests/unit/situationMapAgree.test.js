import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agreeEffects, mapBranches, _setIO, MAP_RUNS } from '../../services/situation/industries.js'

const node = (node_id, opts) => ({ node_id, question: node_id, status: 'live', options: Object.entries(opts).map(([key, p]) => ({ key, label: key, p })) })

test('agreeEffects: kept only when both runs name the same industry, same direction; the smaller size', () => {
    const a = new Map([['iran|strike', [{ code: 'OIL', direction: 'up', bucket: 'large' }, { code: 'HCT', direction: 'up', bucket: 'small' }, { code: 'AIR', direction: 'down', bucket: 'medium' }]]])
    const b = new Map([['iran|strike', [{ code: 'OIL', direction: 'up', bucket: 'medium' }, { code: 'AIR', direction: 'up', bucket: 'medium' }, { code: 'DEF', direction: 'up', bucket: 'small' }]]])
    const r = agreeEffects(a, b)
    assert.deepEqual(r.effects.get('iran|strike'), [{ code: 'OIL', direction: 'up', bucket: 'medium' }])
    assert.equal(r.disagreed, 4, 'HCT, AIR (both ways) and DEF')
})

test('mapBranches: two runs agreed; one failed run → the other alone', async () => {
    assert.equal(MAP_RUNS, 2)
    const nodes = [node('iran', { strike: 0.2, calm: 0.8 })]
    const inds = [{ code: 'OIL', name: 'Oil', sens: null, reactions: [] }, { code: 'HCT', name: 'HC Tech', sens: null, reactions: [] }]
    let n = 0
    _setIO({ payer: async () => null, system: () => 'S', call: async () => ({ data: { branches: [{ branch: 1, effects: n++ === 0
        ? [{ code: 'OIL', direction: 'up', bucket: 'large', why: 'w' }, { code: 'HCT', direction: 'up', bucket: 'small', why: 'w' }]
        : [{ code: 'OIL', direction: 'up', bucket: 'large', why: 'w' }] }] } }) })
    const r = await mapBranches(nodes, inds)
    assert.deepEqual(r.effects.get('iran|strike').map(e => e.code), ['OIL'])
    assert.equal(r.runs, 2)
    n = 0
    _setIO({ call: async () => { if (n++ === 0) throw new Error('overloaded'); return { data: { branches: [{ branch: 1, effects: [{ code: 'HCT', direction: 'up', bucket: 'small', why: 'w' }] }] } } } })
    const one = await mapBranches(nodes, inds)
    assert.equal(one.runs, 1)
    assert.deepEqual(one.effects.get('iran|strike').map(e => e.code), ['HCT'])
})
