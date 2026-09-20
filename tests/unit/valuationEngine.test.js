import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computeValuation, computeEventDelta, EVENT_DELTA_MAX_QUARTERS, percentile, median } from '../../services/valuation.engine.js'

// Analyst P2 — deterministic relative valuation. Pure → exhaustively testable.

// ── percentile / median ──────────────────────────────────────────────────────
test('percentile: linear interpolation between ranks; median = p50', () => {
    assert.equal(percentile([15, 18, 20, 22, 25], 25), 18)
    assert.equal(percentile([15, 18, 20, 22, 25], 50), 20)
    assert.equal(percentile([15, 18, 20, 22, 25], 75), 22)
    assert.equal(median([10, 20]), 15)             // interpolated
    assert.equal(percentile([], 50), null)
    assert.equal(percentile([42], 25), 42)         // single point
})

// ── pe with a provided (agent-justified) multiple ────────────────────────────
test('pe: provided multiple × forward EPS → PT, ±15% bear/base/bull', () => {
    const v = computeValuation({ method: 'pe', multiple: 20, forward_metric: 10 })
    assert.equal(v.ok, true)
    assert.equal(v.multiple.basis, 'provided')
    assert.deepEqual(v.multiple, { used: 20, low: 17, high: 23, basis: 'provided' })
    assert.deepEqual(v.pt, { bear: 170, base: 200, bull: 230 })
    assert.equal(v.our_pt, 200)
})

// ── scenario bands: each leg its OWN multiple AND its OWN earnings ───────────
test('no scenarios → the band is labelled multiple_sensitivity, EPS held constant', () => {
    const v = computeValuation({ method: 'pe', multiple: 20, forward_metric: 10 })
    assert.equal(v.band_basis, 'multiple_sensitivity')
    // every leg priced off the SAME earnings — that is what makes it not a downside case
    assert.equal(v.legs.bear.forward_metric, 10)
    assert.equal(v.legs.bull.forward_metric, 10)
    assert.equal(v.legs.bear.basis, 'multiple_sensitivity')
})

test('a bear scenario compresses the multiple AND the earnings together', () => {
    // SNDK's real judgment, which the old engine could not express at any multiple: a trough multiple
    // on trough earnings. The ±15% band would have said 1870; the cycle case says 700.
    const v = computeValuation({
        method: 'pe', multiple: 10, forward_metric: 220,
        scenarios: { bear: { multiple: 3.5, forward_metric: 200 } },
    })
    assert.equal(v.band_basis, 'scenario')
    assert.equal(v.pt.bear, 700)                  // 3.5 × 200
    assert.equal(v.pt.base, 2200)                 // base untouched
    assert.equal(v.pt.bull, 2530)                 // bull still ±15% — legs are independent
    assert.deepEqual(v.legs.bear, { value: 700, multiple: 3.5, forward_metric: 200, basis: 'scenario' })
    assert.equal(v.legs.bull.basis, 'multiple_sensitivity')
})

test('a leg may vary just one input — the other inherits the base', () => {
    const reRate = computeValuation({ method: 'pe', multiple: 20, forward_metric: 10, scenarios: { bear: { multiple: 12 } } })
    assert.equal(reRate.pt.bear, 120)                        // 12 × the base EPS 10
    assert.equal(reRate.legs.bear.forward_metric, 10)

    const earnings = computeValuation({ method: 'pe', multiple: 20, forward_metric: 10, scenarios: { bear: { forward_metric: 6 } } })
    assert.equal(earnings.pt.bear, 120)                      // the base multiple 20 × 6
    assert.equal(earnings.legs.bear.multiple, 20)
})

test('an unusable scenario leg falls back to sensitivity rather than poisoning the band', () => {
    for (const bad of [{ multiple: 0 }, { forward_metric: -5 }, { multiple: 'x' }, {}, null]) {
        const v = computeValuation({ method: 'pe', multiple: 20, forward_metric: 10, scenarios: { bear: bad } })
        assert.equal(v.pt.bear, 170, `bear=${JSON.stringify(bad)}`)
        assert.equal(v.band_basis, 'multiple_sensitivity', `bear=${JSON.stringify(bad)}`)
    }
})

test('ev_* scenarios ride the equity bridge too', () => {
    const v = computeValuation({
        method: 'ev_ebitda', multiple: 10, forward_metric: 1000, shares_out: 100, net_debt: 2000,
        scenarios: { bear: { multiple: 6, forward_metric: 800 } },
    })
    assert.equal(v.pt.base, 80)     // (10×1000 − 2000)/100
    assert.equal(v.pt.bear, 28)     // (6×800 − 2000)/100
    assert.equal(v.band_basis, 'scenario')
})

test('pe: the GAP vs consensus + upside vs price', () => {
    const v = computeValuation({ method: 'pe', multiple: 20, forward_metric: 10, consensus_pt: 180, current_price: 150 })
    assert.deepEqual(v.gap, { value: 20, pct: 11.11 })     // (200-180)/180
    assert.equal(v.upside_pct, 33.33)                       // (200-150)/150
})

test('pe: no consensus PT → gap null; no price → upside null', () => {
    const v = computeValuation({ method: 'pe', multiple: 20, forward_metric: 10 })
    assert.equal(v.gap, null)
    assert.equal(v.upside_pct, null)
})

// ── derived multiple (no agent override) ─────────────────────────────────────
test('pe: derives base from historical quartiles (>=4 points)', () => {
    const v = computeValuation({ method: 'pe', forward_metric: 10, historical_multiples: [15, 18, 20, 22, 25] })
    assert.equal(v.multiple.basis, 'historical_quartiles')
    assert.deepEqual(v.multiple, { used: 20, low: 18, high: 22, basis: 'historical_quartiles' })
    assert.deepEqual(v.pt, { bear: 180, base: 200, bull: 220 })
    assert.equal(v.historical_median_multiple, 20)
})

test('pe: <4 historical points → median ±15% band', () => {
    const v = computeValuation({ method: 'pe', forward_metric: 10, historical_multiples: [18, 22] })
    assert.equal(v.multiple.basis, 'historical_median')
    assert.deepEqual(v.multiple, { used: 20, low: 17, high: 23, basis: 'historical_median' })   // median=20, ±15%
})

test('peer_median_multiple is surfaced as context', () => {
    const v = computeValuation({ method: 'pe', multiple: 20, forward_metric: 10, peer_multiples: [16, 18, 24] })
    assert.equal(v.peer_median_multiple, 18)
})

// ── EV methods (equity bridge) ───────────────────────────────────────────────
test('ev_sales: EV = multiple × revenue → equity (−net debt) → per share', () => {
    const v = computeValuation({ method: 'ev_sales', multiple: 5, forward_metric: 1000, shares_out: 100, net_debt: 200 })
    // base: (5*1000 - 200)/100 = 48 ; low 4.25→40.5 ; high 5.75→55.5
    assert.deepEqual(v.pt, { bear: 40.5, base: 48, bull: 55.5 })
    assert.equal(v.our_pt, 48)
})

test('ev method without shares → ev_needs_shares', () => {
    const v = computeValuation({ method: 'ev_ebitda', multiple: 12, forward_metric: 500 })
    assert.deepEqual(v, { ok: false, reason: 'ev_needs_shares' })
})

// ── guards ───────────────────────────────────────────────────────────────────
test('rejects a non-positive / missing forward metric (can not value a loss)', () => {
    assert.equal(computeValuation({ method: 'pe', multiple: 20, forward_metric: -3 }).reason, 'forward_metric_required')
    assert.equal(computeValuation({ method: 'pe', multiple: 20 }).reason, 'forward_metric_required')
})

test('rejects when neither a provided multiple nor history is available', () => {
    assert.deepEqual(computeValuation({ method: 'pe', forward_metric: 10 }), { ok: false, reason: 'no_multiple' })
})

test('unknown method falls back to pe', () => {
    const v = computeValuation({ method: 'bogus', multiple: 20, forward_metric: 10 })
    assert.equal(v.method, 'pe')
    assert.equal(v.our_pt, 200)
})

// ─── one event, priced alone ──────────────────────────────────────────────────
// Δ NI = revenue × exposed × shock × margin × (q/4); Δ price % = Δ NI / NI at a constant multiple;
// remaining = Δ price % − moved. The two guesses (shock, persistence) are the model's; the
// arithmetic is here, so a read's sizing can be checked by hand from its own inputs.

const BASE = { exposed_revenue_pct: 0.12, shock_pct: -0.30, incremental_margin: 0.5, persistence_quarters: 2,
               revenue: 50e9, net_income: 4e9, spot: 100 }

test('event delta: the worked example — 12% exposed, −30% for two quarters at 50% drop-through', () => {
    const d = computeEventDelta({ ...BASE, shock_low: -0.2, shock_high: -0.4, moved_pct: -2 })
    assert.equal(d.ok, true)
    assert.equal(d.delta_net_income, -450e6)          // 50e9 × 0.12 × −0.30 × 0.5 × 0.5
    assert.equal(d.delta_price_pct, -11.25)           // −450M / 4B
    assert.equal(d.implied_price, 88.75)
    assert.equal(d.remaining_pct, -9.25)              // −11.25 − (−2)
    // The band is ordered by value — the worse number left — whichever leg was called "low".
    assert.equal(d.delta_price_low, -15); assert.equal(d.delta_price_high, -7.5)
})

test('event delta: a positive shock lifts the price; the band still reads worse-to-better', () => {
    const d = computeEventDelta({ ...BASE, shock_pct: 0.2, shock_low: 0.1, shock_high: 0.3 })
    assert.equal(d.delta_price_pct, 7.5)
    assert.equal(d.delta_price_low, 3.75); assert.equal(d.delta_price_high, 11.25)
    assert.equal(d.remaining_pct, null)               // nothing moved was given
})

test('event delta: persistence caps at a year — forward EPS is annual', () => {
    const four = computeEventDelta({ ...BASE, persistence_quarters: 4 })
    const eight = computeEventDelta({ ...BASE, persistence_quarters: 8 })
    assert.equal(EVENT_DELTA_MAX_QUARTERS, 4)
    assert.equal(eight.delta_price_pct, four.delta_price_pct)
    assert.equal(eight.inputs.persistence_capped, true)
    assert.equal(four.inputs.persistence_capped, false)
})

test('event delta: inputs are clamped to their ranges, never rejected for being a little over', () => {
    const d = computeEventDelta({ ...BASE, exposed_revenue_pct: 1.4, incremental_margin: -0.2 })
    assert.equal(d.inputs.exposed_revenue_pct, 1)
    assert.equal(d.inputs.incremental_margin, 0)
    assert.equal(Math.abs(d.delta_price_pct), 0)   // −0 from a negative shock × a zero margin
})

test('event delta: a loss-maker gets the dollar figure and no percentage', () => {
    const d = computeEventDelta({ ...BASE, net_income: -5e7 })
    assert.equal(d.ok, true); assert.equal(d.reason, 'no_earnings_base')
    assert.equal(d.delta_net_income, -450e6)
    assert.equal(d.delta_price_pct, null); assert.equal(d.implied_price, null); assert.equal(d.remaining_pct, null)
})

test('event delta: a missing judgement input, or no revenue, is a refusal that names itself', () => {
    assert.deepEqual(computeEventDelta({ ...BASE, shock_pct: undefined }), { ok: false, reason: 'inputs_required' })
    assert.deepEqual(computeEventDelta({ ...BASE, incremental_margin: 'half' }), { ok: false, reason: 'inputs_required' })
    assert.deepEqual(computeEventDelta({ ...BASE, revenue: null }), { ok: false, reason: 'no_revenue' })
    assert.deepEqual(computeEventDelta({ ...BASE, revenue: 0 }), { ok: false, reason: 'no_revenue' })
})

test('event delta: no spot means no implied price, and the percentages still stand', () => {
    const d = computeEventDelta({ ...BASE, spot: null })
    assert.equal(d.spot, null); assert.equal(d.implied_price, null); assert.equal(d.delta_price_pct, -11.25)
})
