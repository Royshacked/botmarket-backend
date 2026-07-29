import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeCoverage, newRevision, RATINGS, STATUSES, coverageService } from '../../api/analyst/coverage.service.js'

// Analyst P1 — coverage schema normalizer (pure). The CRUD methods are DB-bound (not unit-tested,
// mirroring normalizeCall vs saveKairosCall).

// ── normalizeCoverage: identity + defaults ──────────────────────────────────
test('normalize: uppercases symbol, defaults status=active, stamps id + timestamps', () => {
    const c = normalizeCoverage({ symbol: 'nvda' }, 'u1')
    assert.equal(c.symbol, 'NVDA')
    assert.equal(c.userId, 'u1')
    assert.equal(c.status, 'active')
    assert.match(c.id, /^cov_NVDA_[0-9a-f]{8}$/)
    assert.ok(c.created_at && c.updated_at)
})

test('normalize: a passed id + created_at are preserved (the update path); updated_at is fresh', () => {
    const c = normalizeCoverage({ symbol: 'AAPL', id: 'cov_fixed', created_at: '2026-01-01T00:00:00.000Z' }, 'u1')
    assert.equal(c.id, 'cov_fixed')
    assert.equal(c.created_at, '2026-01-01T00:00:00.000Z')
    assert.notEqual(c.updated_at, '2026-01-01T00:00:00.000Z')
})

test('normalize: non-object raw → empty symbol + defaults, never throws', () => {
    const c = normalizeCoverage(null, 'u1')
    assert.equal(c.symbol, '')
    assert.equal(c.status, 'active')
    assert.deepEqual(c.catalysts, [])
})

// ── vocab validation ────────────────────────────────────────────────────────
test('normalize: rating validated against RATINGS (unknown → null)', () => {
    assert.equal(normalizeCoverage({ symbol: 'X', rating: 'buy' }).rating, 'buy')
    assert.equal(normalizeCoverage({ symbol: 'X', rating: 'strong_buy' }).rating, 'strong_buy')
    assert.equal(normalizeCoverage({ symbol: 'X', rating: 'accumulate' }).rating, null)
    assert.ok(RATINGS.includes('hold') && STATUSES.includes('thesis_broken'))
})

test('normalize: status validated (unknown → default active)', () => {
    assert.equal(normalizeCoverage({ symbol: 'X', status: 'watchlist' }).status, 'watchlist')
    assert.equal(normalizeCoverage({ symbol: 'X', status: 'thesis_broken' }).status, 'thesis_broken')
    assert.equal(normalizeCoverage({ symbol: 'X', status: 'bogus' }).status, 'active')
})

// ── numeric sub-objects ─────────────────────────────────────────────────────
test('normalize: price_target requires a numeric value (else null)', () => {
    assert.deepEqual(
        normalizeCoverage({ symbol: 'X', price_target: { value: '182.5', horizon: '12m', basis: '18x FY26 EPS' } }).price_target,
        { value: 182.5, horizon: '12m', basis: '18x FY26 EPS' })
    assert.equal(normalizeCoverage({ symbol: 'X', price_target: { horizon: '12m' } }).price_target, null)   // no value
    assert.equal(normalizeCoverage({ symbol: 'X', price_target: 'nope' }).price_target, null)
})

test('normalize: gap keeps the whole Street distribution; all-absent → null', () => {
    assert.deepEqual(
        normalizeCoverage({ symbol: 'X', gap: { our_pt: 182, consensus_pt: 165, pct: '10.3', low: 140, high: 210, median: 168, pctile: 60 } }).gap,
        { our_pt: 182, consensus_pt: 165, pct: 10.3, low: 140, high: 210, median: 168, pctile: 60 })
    // A mean-only gap still normalizes — the range legs are simply unknown.
    assert.deepEqual(
        normalizeCoverage({ symbol: 'X', gap: { our_pt: 182, consensus_pt: 165, pct: 10.3 } }).gap,
        { our_pt: 182, consensus_pt: 165, pct: 10.3, low: null, high: null, median: null, pctile: null })
    assert.equal(normalizeCoverage({ symbol: 'X', gap: {} }).gap, null)
})

test('normalize: risk_reward legs carry the inputs that produced them', () => {
    assert.equal(normalizeCoverage({ symbol: 'X', risk_reward: {} }).risk_reward, null)
    const rr = normalizeCoverage({
        symbol: 'X',
        risk_reward: {
            bear: { value: 700, multiple: 3.2, forward_metric: 220 },
            base: { value: 2200, multiple: 10, forward_metric: 220 },
            bull: { value: 2530, multiple: 11.5, forward_metric: 220 },
            band_basis: 'scenario',
        },
    }).risk_reward
    assert.deepEqual(rr.bear, { value: 700, multiple: 3.2, forward_metric: 220 })
    assert.equal(rr.band_basis, 'scenario')
    assert.equal(rr.ordered, true)
})

test('normalize: a bare-number leg is widened, not dropped (legacy docs predate the inputs)', () => {
    const rr = normalizeCoverage({ symbol: 'X', risk_reward: { bull: 220, base: 180, bear: 140 } }).risk_reward
    assert.deepEqual(rr.bear, { value: 140, multiple: null, forward_metric: null })
    assert.deepEqual(rr.bull, { value: 220, multiple: null, forward_metric: null })
    assert.equal(rr.band_basis, null)   // unknown — exactly what a legacy band should report
    assert.equal(rr.ordered, true)
})

test('normalize: an out-of-order band is FLAGGED, not silently kept or dropped', () => {
    // SNDK's real defect shape: a leg hand-edited away from the engine's output.
    const rr = normalizeCoverage({ symbol: 'X', risk_reward: { bear: 2400, base: 2200, bull: 2530 } }).risk_reward
    assert.equal(rr.ordered, false)
    assert.equal(rr.bear.value, 2400)   // preserved — a malformed band must not take the thesis with it
})

test('normalize: an unknown band_basis is rejected rather than trusted', () => {
    const rr = normalizeCoverage({ symbol: 'X', risk_reward: { bear: 140, base: 180, bull: 220, band_basis: 'vibes' } }).risk_reward
    assert.equal(rr.band_basis, null)
})

test('normalize: estimates keeps an object, rejects non-object; arrays defaulted', () => {
    assert.deepEqual(normalizeCoverage({ symbol: 'X', estimates: { ours: { eps: 6.1 } } }).estimates, { ours: { eps: 6.1 } })
    assert.deepEqual(normalizeCoverage({ symbol: 'X', estimates: [1, 2] }).estimates, {})   // array → {}
    const c = normalizeCoverage({ symbol: 'X' })
    for (const k of ['catalysts', 'kill_criteria', 'revisions', 'evidence']) assert.deepEqual(c[k], [], `${k} default`)
})

// ── newRevision ─────────────────────────────────────────────────────────────
test('newRevision: builds {at,kind,note,changed}; non-object changed → null; defaults', () => {
    const r = newRevision({ kind: 'rating_change', note: 'upgraded to buy', changed: { rating: { from: 'hold', to: 'buy' } } })
    assert.equal(r.kind, 'rating_change')
    assert.equal(r.note, 'upgraded to buy')
    assert.deepEqual(r.changed, { rating: { from: 'hold', to: 'buy' } })
    assert.ok(r.at)
    const bare = newRevision()
    assert.equal(bare.kind, null)
    assert.equal(bare.changed, null)
    assert.equal(newRevision({ changed: 'nope' }).changed, null)
})

// ─── captureResearchBasis: what a position freezes at entry ─────────────────
// The gate that replaced price-invalidation asks "has our own PT moved against what we paid?", which
// needs a fixed "what we believed at entry" — the live coverage doc is the thing that moves.

const basisDeps = (rows) => ({ getCoverage: async () => rows })

test('research basis: freezes the coverage id + the PT we bought on', async () => {
    const b = await coverageService.captureResearchBasis(
        { userId: 'u1', symbol: 'tsm' },
        basisDeps([{ id: 'cov_TSM_1', symbol: 'TSM', price_target: { value: 702 } }]))
    assert.equal(b.coverageId, 'cov_TSM_1')
    assert.equal(b.coveragePt, 702)
    assert.ok(Date.parse(b.at) > 0)
})

test('research basis: an uncovered name freezes nothing — research is not a precondition for trading', async () => {
    assert.equal(await coverageService.captureResearchBasis({ userId: 'u1', symbol: 'AAPL' },
        basisDeps([{ id: 'c', symbol: 'TSM', price_target: { value: 702 } }])), null)
    assert.equal(await coverageService.captureResearchBasis({ userId: 'u1', symbol: '' }, basisDeps([])), null)
    assert.equal(await coverageService.captureResearchBasis({ symbol: 'TSM' }, basisDeps([])), null)
})

test('research basis: coverage with no usable PT freezes nothing (never a zero)', async () => {
    for (const pt of [null, undefined, {}, { value: null }, { value: 'x' }]) {
        assert.equal(await coverageService.captureResearchBasis({ userId: 'u1', symbol: 'TSM' },
            basisDeps([{ id: 'c', symbol: 'TSM', price_target: pt }])), null, JSON.stringify(pt))
    }
})

test('research basis: a failing coverage read NEVER breaks the order path', async () => {
    const b = await coverageService.captureResearchBasis({ userId: 'u1', symbol: 'TSM' },
        { getCoverage: async () => { throw new Error('mongo down') } })
    assert.equal(b, null)
})
