import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeCoverage, newRevision, RATINGS, STATUSES } from '../../api/analyst/coverage.service.js'

// Analyst P1 — coverage schema normalizer (pure). The CRUD methods are DB-bound (not unit-tested,
// mirroring normalizeCall vs saveKairosCall).

// ── normalizeCoverage: identity + defaults ──────────────────────────────────
test('normalize: uppercases symbol, defaults status=active, stamps id + timestamps', () => {
    const c = normalizeCoverage({ symbol: 'nvda' }, 'u1')
    assert.equal(c.symbol, 'NVDA')
    assert.equal(c.user_id, 'u1')
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

test('normalize: gap coerces numbers; all-absent → null', () => {
    assert.deepEqual(
        normalizeCoverage({ symbol: 'X', gap: { our_pt: 182, consensus_pt: 165, pct: '10.3' } }).gap,
        { our_pt: 182, consensus_pt: 165, pct: 10.3 })
    assert.equal(normalizeCoverage({ symbol: 'X', gap: {} }).gap, null)
})

test('normalize: risk_reward all-null → null; partial kept', () => {
    assert.equal(normalizeCoverage({ symbol: 'X', risk_reward: {} }).risk_reward, null)
    assert.deepEqual(normalizeCoverage({ symbol: 'X', risk_reward: { bull: 220, base: 180, bear: 140 } }).risk_reward,
        { bull: 220, base: 180, bear: 140 })
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
