import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeCoverage, newRevision, RATINGS, STATUSES, HORIZONS, DEFAULT_HORIZON, coverageService } from '../../api/analyst/coverage.service.js'

// Analyst P1 — coverage schema normalizer (pure). The CRUD methods are DB-bound (not unit-tested,
// mirroring normalizeCall vs saveKairosCall).

// ── normalizeCoverage: identity + defaults ──────────────────────────────────
test('normalize: uppercases symbol, defaults status=active, stamps id + timestamps', () => {
    const c = normalizeCoverage({ symbol: 'nvda' })
    assert.equal(c.symbol, 'NVDA')
    assert.equal(c.status, 'active')
    assert.match(c.id, /^cov_NVDA_[0-9a-f]{8}$/)
    assert.ok(c.created_at && c.updated_at)
})

test('normalize: a passed id + created_at are preserved (the update path); updated_at is fresh', () => {
    const c = normalizeCoverage({ symbol: 'AAPL', id: 'cov_fixed', created_at: '2026-01-01T00:00:00.000Z' })
    assert.equal(c.id, 'cov_fixed')
    assert.equal(c.created_at, '2026-01-01T00:00:00.000Z')
    assert.notEqual(c.updated_at, '2026-01-01T00:00:00.000Z')
})

test('normalize: non-object raw → empty symbol + defaults, never throws', () => {
    const c = normalizeCoverage(null)
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
    const pt = normalizeCoverage({ symbol: 'X', price_target: { value: '182.5', horizon: '12m', basis: '18x FY26 EPS', set_at: '2026-01-15T00:00:00.000Z' } }).price_target
    assert.deepEqual(pt, {
        value: 182.5, horizon: '12m', basis: '18x FY26 EPS',
        set_at: '2026-01-15T00:00:00.000Z', target_date: '2027-01-15T00:00:00.000Z',
    })
    assert.equal(normalizeCoverage({ symbol: 'X', price_target: { horizon: '12m' } }).price_target, null)   // no value
    assert.equal(normalizeCoverage({ symbol: 'X', price_target: 'nope' }).price_target, null)
})

// ── the price-target HORIZON (what makes the call scoreable) ────────────────
test('normalize: horizon validated against HORIZONS; anything else → the 12m house default', () => {
    const h = raw => normalizeCoverage({ symbol: 'X', price_target: { value: 100, ...raw } }).price_target.horizon
    for (const v of HORIZONS) assert.equal(h({ horizon: v }), v)
    // The shapes that used to persist verbatim and left the target unscoreable.
    assert.equal(h({ horizon: '12 months' }), DEFAULT_HORIZON)
    assert.equal(h({ horizon: 'end of 2027' }), DEFAULT_HORIZON)
    assert.equal(h({ horizon: '' }), DEFAULT_HORIZON)
    assert.equal(h({}), DEFAULT_HORIZON)          // omitted entirely
    assert.equal(DEFAULT_HORIZON, '12m')
})

test('normalize: target_date is DERIVED from set_at + horizon, never trusted from input', () => {
    const at = '2026-03-10T12:00:00.000Z'
    const td = horizon => normalizeCoverage({ symbol: 'X', price_target: { value: 100, horizon, set_at: at } }).price_target.target_date
    assert.equal(td('3m'),  '2026-06-10T12:00:00.000Z')
    assert.equal(td('6m'),  '2026-09-10T12:00:00.000Z')
    assert.equal(td('12m'), '2027-03-10T12:00:00.000Z')
    assert.equal(td('24m'), '2028-03-10T12:00:00.000Z')
    // A hand-supplied target_date is overwritten — the deadline can't disagree with the horizon.
    assert.equal(
        normalizeCoverage({ symbol: 'X', price_target: { value: 100, horizon: '6m', set_at: at, target_date: '2099-01-01T00:00:00.000Z' } }).price_target.target_date,
        '2026-09-10T12:00:00.000Z')
})

test('normalize: month-end target dates clamp instead of overflowing into the next month', () => {
    // Jan 31 + 1 month is Mar 3 under naive date math. 24m off a leap day is the other trap.
    const td = (set_at, horizon) => normalizeCoverage({ symbol: 'X', price_target: { value: 100, horizon, set_at } }).price_target.target_date
    assert.equal(td('2026-08-31T00:00:00.000Z', '6m'),  '2027-02-28T00:00:00.000Z')
    assert.equal(td('2028-02-29T00:00:00.000Z', '12m'), '2029-02-28T00:00:00.000Z')
    assert.equal(td('2026-05-31T00:00:00.000Z', '3m'),  '2026-08-31T00:00:00.000Z')   // 31-day month → unchanged
})

test('normalize: set_at defaults to now, so a fresh target restarts the clock', () => {
    const before = Date.now()
    const pt = normalizeCoverage({ symbol: 'X', price_target: { value: 100 } }).price_target
    assert.ok(Date.parse(pt.set_at) >= before && Date.parse(pt.set_at) <= Date.now())
    // ...and an existing set_at survives re-normalization, which is what keeps a daily monitor patch
    // (spreading the stored price_target through) from pushing the deadline out one day at a time.
    const kept = normalizeCoverage({ symbol: 'X', price_target: pt }).price_target
    assert.equal(kept.set_at, pt.set_at)
    assert.equal(kept.target_date, pt.target_date)
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

const basisDeps = (doc) => ({ getBySymbol: async () => doc })

test('research basis: freezes the coverage id + the PT we bought on', async () => {
    const b = await coverageService.captureResearchBasis(
        { symbol: 'tsm' },
        basisDeps({ id: 'cov_TSM_1', symbol: 'TSM', price_target: { value: 702 } }))
    assert.equal(b.coverageId, 'cov_TSM_1')
    assert.equal(b.coveragePt, 702)
    assert.ok(Date.parse(b.at) > 0)
})

test('research basis: an uncovered name freezes nothing — research is not a precondition for trading', async () => {
    assert.equal(await coverageService.captureResearchBasis({ symbol: 'AAPL' }, basisDeps(null)), null)
    assert.equal(await coverageService.captureResearchBasis({ symbol: '' }, basisDeps(null)), null)
    assert.equal(await coverageService.captureResearchBasis({}, basisDeps(null)), null)
})

test('research basis: coverage with no usable PT freezes nothing (never a zero)', async () => {
    for (const pt of [null, undefined, {}, { value: null }, { value: 'x' }]) {
        assert.equal(await coverageService.captureResearchBasis(
            { symbol: 'TSM' },
            basisDeps({ id: 'c', symbol: 'TSM', price_target: pt })), null, JSON.stringify(pt))
    }
})

test('research basis: a failing coverage read NEVER breaks the order path', async () => {
    const b = await coverageService.captureResearchBasis(
        { symbol: 'TSM' },
        { getBySymbol: async () => { throw new Error('mongo down') } })
    assert.equal(b, null)
})
