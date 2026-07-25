import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyGapState, recomputeGap, statusForState, nextCheckAt } from '../../monitoring/coverage.assess.js'

// Analyst P5 — the deterministic gap-classification core (pure). Monitoring tracks THE GAP (our view vs
// the Street), not just price-hit.

const bull = (over = {}) => ({
    rating: 'buy',
    price_target: { value: 200 },
    gap: { our_pt: 200, consensus_pt: 180, pct: 11.11 },
    risk_reward: { bull: 240, base: 200, bear: 150 },
    ...over,
})
const bear = (over = {}) => ({
    rating: 'sell',
    price_target: { value: 150 },
    gap: { our_pt: 150, consensus_pt: 180, pct: -16.67 },
    risk_reward: { bull: 200, base: 175, bear: 130 },
    ...over,
})

// ── recomputeGap ─────────────────────────────────────────────────────────────
test('recomputeGap: our PT vs Street → value + pct; missing/zero → null', () => {
    assert.deepEqual(recomputeGap(200, 180), { our_pt: 200, consensus_pt: 180, pct: 11.11 })
    assert.equal(recomputeGap(200, null), null)
    assert.equal(recomputeGap(200, 0), null)
})

// ── target_hit ───────────────────────────────────────────────────────────────
test('bullish: price reaches our PT → target_hit; edge_gone only when the Street has caught up', () => {
    assert.equal(classifyGapState(bull(), { price: 205, consensus_pt: 190 }).state, 'target_hit')
    assert.equal(classifyGapState(bull(), { price: 205, consensus_pt: 190 }).edge_gone, false)  // Street still below
    assert.equal(classifyGapState(bull(), { price: 205, consensus_pt: 210 }).edge_gone, true)   // Street caught up → edge gone
})

test('bearish: price falls to our PT → target_hit', () => {
    assert.equal(classifyGapState(bear(), { price: 148, consensus_pt: 180 }).state, 'target_hit')
})

// ── thesis_broken (price through the invalidation edge) ──────────────────────
test('bullish: price ≤ bear case → thesis_broken', () => {
    assert.equal(classifyGapState(bull(), { price: 145, consensus_pt: 180 }).state, 'thesis_broken')
})
test('bearish: price ≥ bull case → thesis_broken', () => {
    assert.equal(classifyGapState(bear(), { price: 205, consensus_pt: 180 }).state, 'thesis_broken')
})

// ── the gap direction (validating vs diverging) ──────────────────────────────
test('bullish: Street PT rising toward ours → validating; falling → diverging', () => {
    assert.equal(classifyGapState(bull(), { price: 190, consensus_pt: 190 }).state, 'validating')  // 180→190 up
    assert.equal(classifyGapState(bull(), { price: 190, consensus_pt: 170 }).state, 'diverging')   // 180→170 down
})
test('bearish: Street PT falling toward ours → validating', () => {
    assert.equal(classifyGapState(bear(), { price: 170, consensus_pt: 165 }).state, 'validating')  // 180→165 down (toward 150)
})

test('a sub-threshold consensus move is stable (noise)', () => {
    assert.equal(classifyGapState(bull(), { price: 190, consensus_pt: 181 }).state, 'stable')  // 180→181 = 0.6% < 2%
})

// ── status mapping + cadence ─────────────────────────────────────────────────
test('statusForState: terminal states map to status; signals leave it unchanged', () => {
    assert.equal(statusForState('target_hit'), 'target_hit')
    assert.equal(statusForState('thesis_broken'), 'thesis_broken')
    assert.equal(statusForState('validating'), null)
    assert.equal(statusForState('diverging'), null)
    assert.equal(statusForState('stable'), null)
})

test('nextCheckAt: terminal → null (stop watching); active → +1 day ISO', () => {
    assert.equal(nextCheckAt(bull(), 'target_hit', 0), null)
    assert.equal(nextCheckAt(bull(), 'thesis_broken', 0), null)
    assert.equal(nextCheckAt(bull(), 'stable', 0), '1970-01-02T00:00:00.000Z')  // base 0 + 24h
})
