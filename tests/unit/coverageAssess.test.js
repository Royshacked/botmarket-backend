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
test('recomputeGap: a bare consensus number still works; missing/zero → null', () => {
    assert.deepEqual(recomputeGap(200, 180),
        { our_pt: 200, consensus_pt: 180, pct: 11.11, low: null, high: null, median: null, pctile: null })
    assert.equal(recomputeGap(200, null), null)
    assert.equal(recomputeGap(200, 0), null)
    assert.equal(recomputeGap(200, { consensus: 0 }), null)
})

test('recomputeGap: the whole Street distribution, with our percentile inside its range', () => {
    // TSM's real shape: our 516 is 12% under the mean, but the Street spans 500–700 — an analyst is
    // already BELOW us. The percentage says "contrarian"; the percentile says "8th, inside the pack".
    const g = recomputeGap(516, { consensus: 596, low: 500, high: 700, median: 600 })
    assert.equal(g.pct, -13.42)
    assert.equal(g.pctile, 8)
    assert.deepEqual([g.low, g.high, g.median], [500, 700, 600])
})

test('recomputeGap: pctile clamps to 0–100 and needs a real range', () => {
    assert.equal(recomputeGap(900, { consensus: 596, low: 500, high: 700 }).pctile, 100)  // above the whole range
    assert.equal(recomputeGap(100, { consensus: 596, low: 500, high: 700 }).pctile, 0)    // below it
    assert.equal(recomputeGap(516, { consensus: 596, low: 600, high: 600 }).pctile, null) // degenerate range
    assert.equal(recomputeGap(516, { consensus: 596 }).pctile, null)                      // no range at all
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

// ── target_hit_early: WHEN the target was reached is the whole point of storing a horizon ──────
// A 12m target reached in week three and one reached in month eleven used to be recorded identically.
// They are opposite outcomes: the early one says our number was too LOW.
const DAY = 24 * 60 * 60 * 1000
// A 12m call set at t0, with the clock handed in as `nowMs` (the monitor's).
const dated = (over = {}) => bull({
    price_target: { value: 200, horizon: '12m', set_at: '2026-01-01T00:00:00.000Z', target_date: '2027-01-01T00:00:00.000Z' },
    ...over,
})
const at = days => Date.parse('2026-01-01T00:00:00.000Z') + days * DAY

test('a target reached in the first quarter of its window → target_hit_early, never edge_gone', () => {
    const v = classifyGapState(dated(), { price: 205, consensus_pt: 210, nowMs: at(21) })
    assert.equal(v.state, 'target_hit_early')
    assert.match(v.reason, /too low/)
    assert.match(v.reason, /12m/)
    // The Street sitting above our PT would read as edge_gone on a normal hit. On an early one it must
    // not: agreeing with a number we now think was wrong is no reason to harvest.
    assert.equal(v.edge_gone, false)
})

test('past the quarter mark it is an ordinary target_hit, edge_gone intact', () => {
    const v = classifyGapState(dated(), { price: 205, consensus_pt: 210, nowMs: at(200) })
    assert.equal(v.state, 'target_hit')
    assert.equal(v.edge_gone, true)
})

test('the early boundary scales with the horizon, not a fixed period', () => {
    // 30 days is a third of a 3m call (ordinary) but 4% of a 24m one (early).
    const short = dated({ price_target: { value: 200, horizon: '3m', set_at: '2026-01-01T00:00:00.000Z', target_date: '2026-04-01T00:00:00.000Z' } })
    const long  = dated({ price_target: { value: 200, horizon: '24m', set_at: '2026-01-01T00:00:00.000Z', target_date: '2028-01-01T00:00:00.000Z' } })
    assert.equal(classifyGapState(short, { price: 205, nowMs: at(30) }).state, 'target_hit')
    assert.equal(classifyGapState(long,  { price: 205, nowMs: at(30) }).state, 'target_hit_early')
})

test('bearish theses split the same way', () => {
    const b = bear({ price_target: { value: 150, horizon: '12m', set_at: '2026-01-01T00:00:00.000Z', target_date: '2027-01-01T00:00:00.000Z' } })
    assert.equal(classifyGapState(b, { price: 148, nowMs: at(10) }).state,  'target_hit_early')
    assert.equal(classifyGapState(b, { price: 148, nowMs: at(300) }).state, 'target_hit')
})

test('a hit after the deadline is still a plain target_hit — late is not early', () => {
    assert.equal(classifyGapState(dated(), { price: 205, nowMs: at(500) }).state, 'target_hit')
})

// Timing SHARPENS a hit; it is never a precondition for noticing one. Coverage written before the
// deadline existed, or checked without a clock, must classify exactly as it did before.
test('no clock or no stored deadline → degrades to plain target_hit', () => {
    assert.equal(classifyGapState(dated(), { price: 205 }).state, 'target_hit')                        // no nowMs
    assert.equal(classifyGapState(bull(),  { price: 205, nowMs: at(1) }).state, 'target_hit')          // legacy PT, no dates
    const malformed = dated({ price_target: { value: 200, horizon: '12m', set_at: 'nonsense', target_date: '2027-01-01T00:00:00.000Z' } })
    assert.equal(classifyGapState(malformed, { price: 205, nowMs: at(1) }).state, 'target_hit')
})

// ── the valuation band is NOT an invalidation level ──────────────────────────
// risk_reward is a ±15% sensitivity around our multiple with EPS held constant — for a bullish name it
// routinely sits ABOVE spot, so reading `bear` as a stop broke every thesis on its first check. Research
// has no position and therefore no invalidation: a buy thesis whose price falls is CHEAPER, not wrong.
test('price far below the bear band does not break a bullish thesis', () => {
    assert.equal(classifyGapState(bull(), { price: 145, consensus_pt: 180 }).state, 'stable')
    assert.equal(classifyGapState(bull(), { price: 1, consensus_pt: 180 }).state, 'stable')
})
test('price far above the bull band does not break a bearish thesis', () => {
    assert.equal(classifyGapState(bear(), { price: 205, consensus_pt: 180 }).state, 'stable')
})
test('the real TSM shape that broke the book: bear case ABOVE spot is not a verdict', () => {
    // Initiated at spot ~404 with a ±15% band around PT 702 → "bear" 597, i.e. $193 ABOVE the market.
    const tsm = { rating: 'buy', price_target: { value: 702 }, gap: { consensus_pt: 586 }, risk_reward: { bull: 810, base: 702, bear: 597 } }
    assert.equal(classifyGapState(tsm, { price: 404, consensus_pt: 586 }).state, 'stable')
})

// ── a missing price is NOT a collapse (regression) ───────────────────────────
// A failed quote once reached here as the number 0 (Number(null) === 0) and read as "price 0 ≤ bear
// case", breaking every covered thesis on its first check. Absent/zero/negative price → no verdict.
test('missing or zero price never fires a terminal verdict', () => {
    for (const price of [null, undefined, '', 0, -5, NaN]) {
        assert.equal(classifyGapState(bull(), { price, consensus_pt: 180 }).state, 'stable', `bull price=${String(price)}`)
        assert.equal(classifyGapState(bear(), { price, consensus_pt: 180 }).state, 'stable', `bear price=${String(price)}`)
    }
})

test('a missing price still lets the consensus signal through', () => {
    // No price to compare, but the Street moved — that judgement needs no price at all.
    assert.equal(classifyGapState(bull(), { price: null, consensus_pt: 190 }).state, 'validating')
})

test('a missing price cannot fake reaching our target', () => {
    for (const price of [null, 0, '']) {
        assert.equal(classifyGapState(bear(), { price, consensus_pt: 180 }).state, 'stable', `price=${String(price)}`)
    }
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
test('statusForState: only target_hit moves the status; signals leave it unchanged', () => {
    assert.equal(statusForState('target_hit'), 'target_hit')
    assert.equal(statusForState('validating'), null)
    assert.equal(statusForState('diverging'), null)
    assert.equal(statusForState('stable'), null)
    // An early hit deliberately leaves the thesis ACTIVE. Retiring it as `target_hit` would book a
    // mis-calibrated model as a win and stop the research that should follow it.
    assert.equal(statusForState('target_hit_early'), null)
})

test('statusForState never returns thesis_broken — no deterministic kill exists', () => {
    for (const s of ['thesis_broken', 'validating', 'diverging', 'stable', 'anything']) {
        assert.notEqual(statusForState(s), 'thesis_broken')
    }
})

test('nextCheckAt: ALWAYS a next check — a thesis lives until the user retires it', () => {
    for (const state of ['target_hit', 'target_hit_early', 'validating', 'diverging', 'stable']) {
        assert.equal(nextCheckAt(bull(), state, 0), '1970-01-02T00:00:00.000Z', state)  // base 0 + 24h
    }
})
