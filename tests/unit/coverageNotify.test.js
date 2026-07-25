import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildCoverageEvent } from '../../services/coverageNotify.service.js'

// Analyst P5 — coverage-event notification card (pure builder).

const cov = (over = {}) => ({ user_id: 'u1', symbol: 'NVDA', id: 'cov1', price_target: { value: 200 }, ...over })

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

test('thesis_broken / validating / diverging each phrase the reason', () => {
    assert.match(buildCoverageEvent(cov(), { state: 'thesis_broken', reason: 'price ≤ bear' }).content, /thesis BROKEN: price ≤ bear/)
    assert.match(buildCoverageEvent(cov(), { state: 'validating', reason: 'Street catching up' }).content, /playing out: Street catching up/)
    assert.match(buildCoverageEvent(cov(), { state: 'diverging', reason: 'Street moving away' }).content, /increasingly contrarian/)
})

test('stable / no-user / no-verdict → null (no notification)', () => {
    assert.equal(buildCoverageEvent(cov(), { state: 'stable', reason: 'x' }), null)
    assert.equal(buildCoverageEvent(cov({ user_id: null }), { state: 'target_hit' }), null)
    assert.equal(buildCoverageEvent(cov(), null), null)
    assert.equal(buildCoverageEvent(null, { state: 'target_hit' }), null)
})
