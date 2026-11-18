import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _atlasGo } from '../../services/agents/portfolio.agent.service.js'

const SIZED = { positionSize: 20000, ideas: [{ asset: 'MSFT', quantity: 10 }] }

test('Atlas go: his <go> tag on a new book', () => {
    assert.equal(_atlasGo({ raw: 'Built. <go>{}</go>' }), true)
    assert.equal(_atlasGo({ raw: 'Built. <go>{}</go>', portfolioId: 'p1' }), false, 'a saved book keeps its own press')
})

test('Atlas go: a cut-short turn holding a SIZED plan is done, not carried (the drive, 2026-11-17: three re-plans, no go)', () => {
    assert.equal(_atlasGo({ raw: 'plan…', cutShort: true, plan: SIZED, reply: 'Here is the book.' }), true)
})

test('Atlas go: nothing implied without a cut-short, a sized plan, or when he asks, adopts, or edits', () => {
    assert.equal(_atlasGo({ raw: 'plan…', cutShort: false, plan: SIZED, reply: 'Here is the book.' }), false)
    assert.equal(_atlasGo({ raw: 'plan…', cutShort: true, plan: { positionSize: null }, reply: 'x' }), false)
    assert.equal(_atlasGo({ raw: 'plan…', cutShort: true, plan: null, reply: 'x' }), false)
    assert.equal(_atlasGo({ raw: 'plan…', cutShort: true, plan: SIZED, reply: 'What capital should I use?' }), false)
    assert.equal(_atlasGo({ raw: 'plan…', cutShort: true, plan: SIZED, adopt: true, reply: 'x' }), false)
    assert.equal(_atlasGo({ raw: 'plan…', cutShort: true, plan: SIZED, portfolioId: 'p1', reply: 'x' }), false)
    // CR 2026-11-18: sleeves still out with the picker, or a route on the turn → not done yet
    assert.equal(_atlasGo({ raw: 'plan…', cutShort: true, plan: SIZED, reply: 'x', pending: true }), false)
})
