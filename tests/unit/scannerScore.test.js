import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _normalizeScan, _cleanScore, _normalizeKairosPick } from '../../services/scanner.agent.service.js'

// A minimal well-formed candidate the model might emit.
function cand(ticker, total, extra = {}) {
    return {
        ticker,
        direction: 'long',
        thesis: 't',
        analysis: 'a',
        score: { total, catalyst: 80, technical: 70, relativeStrength: 60, liquidity: 90 },
        ...extra,
    }
}

// ── _cleanScore ─────────────────────────────────────────────────────────
test('cleanScore: full card clamps to 0–100 integers', () => {
    const s = _cleanScore({ total: 82.6, catalyst: 140, technical: -5, relativeStrength: 55, liquidity: 90 })
    assert.deepEqual(s, { total: 83, catalyst: 100, technical: 0, relativeStrength: 55, liquidity: 90 })
})

test('cleanScore: partial card keeps present axes, nulls the rest', () => {
    const s = _cleanScore({ total: 70, technical: 65 })
    assert.deepEqual(s, { total: 70, catalyst: null, technical: 65, relativeStrength: null, liquidity: null })
})

test('cleanScore: non-object / all-empty → null (no empty card renders)', () => {
    assert.equal(_cleanScore(null), null)
    assert.equal(_cleanScore('nope'), null)
    assert.equal(_cleanScore({ total: 'x', catalyst: null }), null)
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

test('normalizeScan: clean candidate carries the normalized score through', () => {
    const scan = { thesis: 's', direction: 'long', candidates: [cand('AAA', 88)] }
    const out = _normalizeScan(scan)
    assert.deepEqual(out.candidates[0].score, { total: 88, catalyst: 80, technical: 70, relativeStrength: 60, liquidity: 90 })
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
