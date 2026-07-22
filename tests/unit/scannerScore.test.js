import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _normalizeScan, _cleanScore, _normalizeKairosPick } from '../../services/scanner.agent.service.js'

// A minimal well-formed candidate the model might emit. The 2nd arg drives the
// `technical` axis — since `total` is now recomputed from the axes (Argus #2), a
// varying axis is what produces different composite totals for ranking.
function cand(ticker, technical, extra = {}) {
    return {
        ticker,
        direction: 'long',
        thesis: 't',
        analysis: 'a',
        score: { catalyst: 80, technical, relativeStrength: 60, liquidity: 90 },
        ...extra,
    }
}

// ── _cleanScore (axes clamp + deterministic total) ──────────────────────
// No style passed → swing weights { C .30, T .30, R .25, L .15 }.
test('cleanScore: axes clamp to 0–100 ints; total is recomputed from them (model total discarded)', () => {
    // clamped axes: catalyst 100, technical 0, rs 55, liquidity 90
    // swing total = 100*.30 + 0*.30 + 55*.25 + 90*.15 = 30 + 0 + 13.75 + 13.5 = 57.25 → 57
    const s = _cleanScore({ total: 82.6, catalyst: 140, technical: -5, relativeStrength: 55, liquidity: 90 })
    assert.deepEqual(s, { total: 57, catalyst: 100, technical: 0, relativeStrength: 55, liquidity: 90 })
})

test('cleanScore: partial card keeps present axes; total renormalizes over them', () => {
    // only technical present → total = 65 (weight cancels out)
    const s = _cleanScore({ total: 70, technical: 65 })
    assert.deepEqual(s, { total: 65, catalyst: null, technical: 65, relativeStrength: null, liquidity: null })
})

test('cleanScore: non-object / no-axis → null (a bare total with no axes is not trusted)', () => {
    assert.equal(_cleanScore(null), null)
    assert.equal(_cleanScore('nope'), null)
    assert.equal(_cleanScore({ total: 'x', catalyst: null }), null)
    assert.equal(_cleanScore({ total: 88 }), null)   // total only, no axes → no card
})

// ── deterministic total: style weighting ────────────────────────────────
// rs/liquidity absent (null) so only catalyst + technical drive the renormalized total.
test('cleanScore: same axes, intraday vs long-term diverge (technical- vs catalyst-led)', () => {
    const axes = { catalyst: 90, technical: 30, relativeStrength: null, liquidity: null }
    // intraday C.20 T.40 → (90*.20 + 30*.40)/(.20+.40) = (18+12)/.60 = 50
    assert.equal(_cleanScore(axes, 'intraday').total, 50)
    // long term C.35 T.20 → (90*.35 + 30*.20)/(.35+.20) = (31.5+6)/.55 = 68.18 → 68
    assert.equal(_cleanScore(axes, 'long term').total, 68)
})

test('cleanScore: an unknown/null style falls back to swing weights', () => {
    const axes = { catalyst: 90, technical: 30, relativeStrength: null, liquidity: null }
    // swing C.30 T.30 → (90*.30 + 30*.30)/(.30+.30) = (27+9)/.60 = 60
    assert.equal(_cleanScore(axes).total, 60)
    assert.equal(_cleanScore(axes, 'bogus').total, 60)
})

test('cleanScore: a present 0 axis IS weighted in (not treated as absent)', () => {
    // all four present, one of them 0 → 0 participates and drags the total down.
    const axes = { catalyst: 90, technical: 30, relativeStrength: 0, liquidity: 0 }
    // intraday: 90*.20 + 30*.40 + 0*.30 + 0*.10 = 18 + 12 = 30 (wsum = 1)
    assert.equal(_cleanScore(axes, 'intraday').total, 30)
})

// ── _normalizeScan ranking ──────────────────────────────────────────────
test('normalizeScan: candidates sorted by score.total, highest first', () => {
    const scan = { thesis: 's', direction: 'long', candidates: [cand('AAA', 60), cand('BBB', 90), cand('CCC', 75)] }
    const out = _normalizeScan(scan)
    assert.deepEqual(out.candidates.map(c => c.ticker), ['BBB', 'CCC', 'AAA'])
})

test('normalizeScan: missing/unscored candidates sort last', () => {
    const noScore = { ticker: 'ZZZ', direction: 'long', thesis: 't', analysis: 'a' }
    const scan = { thesis: 's', direction: 'long', candidates: [noScore, cand('AAA', 50)] }
    const out = _normalizeScan(scan)
    assert.deepEqual(out.candidates.map(c => c.ticker), ['AAA', 'ZZZ'])
    assert.equal(out.candidates[1].score, null)
})

test('normalizeScan: equal totals keep emitted order (stable)', () => {
    const scan = { thesis: 's', direction: 'long', candidates: [cand('AAA', 80), cand('BBB', 80)] }
    const out = _normalizeScan(scan)
    assert.deepEqual(out.candidates.map(c => c.ticker), ['AAA', 'BBB'])
})

test('normalizeScan: clean candidate carries the axes + deterministic total', () => {
    const scan = { thesis: 's', direction: 'long', candidates: [cand('AAA', 88)] }
    const out = _normalizeScan(scan)
    // no style → swing: 80*.30 + 88*.30 + 60*.25 + 90*.15 = 24+26.4+15+13.5 = 78.9 → 79
    assert.deepEqual(out.candidates[0].score, { total: 79, catalyst: 80, technical: 88, relativeStrength: 60, liquidity: 90 })
})

// ── _normalizeScan style (shared trade-horizon vocabulary) ──────────────
test('normalizeScan: a valid style is carried through', () => {
    for (const style of ['intraday', 'day', 'swing', 'long term']) {
        const scan = { thesis: 's', direction: 'long', style, candidates: [cand('AAA', 80)] }
        assert.equal(_normalizeScan(scan).style, style)
    }
})

test('normalizeScan: an off-vocabulary style is dropped to null (no "scalp")', () => {
    const scan = { thesis: 's', direction: 'long', style: 'scalp', candidates: [cand('AAA', 80)] }
    assert.equal(_normalizeScan(scan).style, null)
})

test('normalizeScan: a missing style defaults to null', () => {
    const scan = { thesis: 's', direction: 'long', candidates: [cand('AAA', 80)] }
    assert.equal(_normalizeScan(scan).style, null)
})

// ── _normalizeKairosPick (hand-off single pick) ─────────────────────────
test('kairosPick: clean pick uppercases ticker, keeps direction + text + recommended_mode', () => {
    const p = _normalizeKairosPick({ ticker: 'nvda', direction: 'long', thesis: 't', analysis: 'a', recommended_mode: 'smc' })
    assert.deepEqual(p, { ticker: 'NVDA', direction: 'long', thesis: 't', analysis: 'a', recommended_mode: 'smc' })
})

test('kairosPick: direction defaults long; missing text → empty; unknown/absent mode → null', () => {
    assert.deepEqual(_normalizeKairosPick({ ticker: 'AAPL' }), { ticker: 'AAPL', direction: 'long', thesis: '', analysis: '', recommended_mode: null })
    assert.equal(_normalizeKairosPick({ ticker: 'TSLA', direction: 'short' }).direction, 'short')
    assert.equal(_normalizeKairosPick({ ticker: 'TSLA', recommended_mode: 'bogus' }).recommended_mode, null)
})

test('kairosPick: no/empty ticker → null', () => {
    assert.equal(_normalizeKairosPick(null), null)
    assert.equal(_normalizeKairosPick({}), null)
    assert.equal(_normalizeKairosPick({ ticker: '   ' }), null)
})
