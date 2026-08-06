import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildCoverageEvent } from '../../services/coverageNotify.service.js'

// Analyst P5 — coverage-event notification card (pure builder).

const cov = (over = {}) => ({ userId: 'u1', symbol: 'NVDA', id: 'cov1', price_target: { value: 200 }, ...over })

test('target_hit → analyst card; edge_gone adds the harvest nudge', () => {
    const c = buildCoverageEvent(cov(), { state: 'target_hit', reason: 'price 205 reached PT 200', edge_gone: false })
    assert.equal(c.botId, 'analyst')
    assert.equal(c.type, 'coverage_event')
    assert.equal(c.userId, 'u1')
    assert.match(c.content, /NVDA reached our price target \(200\)\./)
    assert.deepEqual(c.payload, { kind: 'coverage', symbol: 'NVDA', coverageId: 'cov1', state: 'target_hit', edge_gone: false })

    const gone = buildCoverageEvent(cov(), { state: 'target_hit', reason: 'x', edge_gone: true })
    assert.match(gone.content, /edge is gone.*harvest/i)
})

test('target_hit_early reads as a MISS — never as a target reached worth harvesting', () => {
    const c = buildCoverageEvent(cov(), {
        state: 'target_hit_early',
        reason: 'price 205 reached PT 200 just 6% into a 12m call — the target was too low',
        edge_gone: false,
    })
    assert.equal(c.payload.state, 'target_hit_early')
    assert.match(c.content, /too fast/)
    assert.match(c.content, /the target was too low/)
    assert.match(c.content, /Re-modelling rather than closing/)
    // The failure this copy guards: a card that announced "reached our price target" and stopped there
    // would invite exactly the harvest the verdict argues against.
    assert.doesNotMatch(c.content, /harvest/i)
})

test('thesis_broken / validating / diverging each phrase the reason', () => {
    assert.match(buildCoverageEvent(cov(), { state: 'thesis_broken', reason: 'price ≤ bear' }).content, /thesis BROKEN: price ≤ bear/)
    assert.match(buildCoverageEvent(cov(), { state: 'validating', reason: 'Street catching up' }).content, /playing out: Street catching up/)
    assert.match(buildCoverageEvent(cov(), { state: 'diverging', reason: 'Street moving away' }).content, /increasingly contrarian/)
})

test('stable / no-user / no-verdict → null (no notification)', () => {
    assert.equal(buildCoverageEvent(cov(), { state: 'stable', reason: 'x' }), null)
    assert.equal(buildCoverageEvent(cov({ userId: null }), { state: 'target_hit' }), null)
    assert.equal(buildCoverageEvent(cov(), null), null)
    assert.equal(buildCoverageEvent(null, { state: 'target_hit' }), null)
})
