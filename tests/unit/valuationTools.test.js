import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatConsensus, valuationReadText, eventDeltaReadText, VALUATION_TOOLS } from '../../services/tools/valuation.tools.js'
import { computeValuation, computeEventDelta } from '../../services/valuation.engine.js'

// Analyst P2 — pure LLM-ready formatters over the consensus feeds + the valuation engine.

// ── formatConsensus ──────────────────────────────────────────────────────────
const grades = { rating: 'Buy', counts: { strong_buy: 30, buy: 15, hold: 5, sell: 1, strong_sell: 0 } }

test('formatConsensus: renders estimates, PT, rating, and an improving revision trend', () => {
    const c = formatConsensus('nvda', {
        estimates: { next: { fy: '2027', eps: 6.5, revenue: 250e9, ebitda: 150e9, num_analysts: 40 } },
        pt: { consensus: 180, low: 120, high: 240 },
        grades,
        gradesHist: [   // newest first: net 44 vs oldest net 32 → improving
            { strong_buy: 30, buy: 15, hold: 5, sell: 1, strong_sell: 0 },
            { strong_buy: 20, buy: 15, hold: 10, sell: 2, strong_sell: 1 },
        ],
    })
    assert.match(c, /NVDA/)
    assert.match(c, /FY2027/)
    assert.match(c, /EPS 6\.5/)
    assert.match(c, /\$250\.0B/)          // revenue money-formatted
    assert.match(c, /consensus 180/)
    assert.match(c, /Rating: Buy/)
    assert.match(c, /improving/)
})

test('formatConsensus: deteriorating + stable + n/a revision trends', () => {
    const mk = hist => formatConsensus('X', { grades, gradesHist: hist })
    assert.match(mk([{ strong_buy: 5, buy: 5, hold: 10, sell: 8, strong_sell: 4 }, { strong_buy: 20, buy: 10, hold: 5, sell: 1, strong_sell: 0 }]), /deteriorating/)
    assert.match(mk([{ strong_buy: 10, buy: 5, hold: 3, sell: 1, strong_sell: 0 }, { strong_buy: 10, buy: 5, hold: 3, sell: 1, strong_sell: 0 }]), /stable/)
    assert.match(mk([{ strong_buy: 10, buy: 5, hold: 3, sell: 1, strong_sell: 0 }]), /Revision trend: n\/a/)  // <2 rows
})

test('formatConsensus: missing pieces degrade gracefully', () => {
    const c = formatConsensus('AAPL', {})
    assert.match(c, /Estimates: none/)
    assert.match(c, /Price target: none/)
    assert.match(c, /Rating: none/)
})

// ── valuationReadText (over real engine output) ──────────────────────────────
test('valuationReadText: an ABOVE-Street view spells out PT, gap, and the edge', () => {
    const r = computeValuation({ method: 'pe', multiple: 32, forward_metric: 6.5, consensus_pt: 180 })  // 208 vs 180
    const t = valuationReadText('nvda', 'pe', r, { fy: '2027', consensusMetric: true })
    assert.match(t, /OUR price target: 208/)
    assert.match(t, /THE GAP: \+28/)
    assert.match(t, /ABOVE the Street/)
    assert.match(t, /Forward metric: 6\.5 \(consensus, FY2027\)/)
})

test('valuationReadText: a near-consensus PT reads as a THIN edge', () => {
    const r = computeValuation({ method: 'pe', multiple: 28, forward_metric: 6.5, consensus_pt: 180 })  // 182 vs 180 → +1.1%
    assert.match(valuationReadText('NVDA', 'pe', r), /thin edge/)
})

// ── the MARKET leg ───────────────────────────────────────────────────────────
// The gap is measured against the Street; a RATING is measured against the price, and only this line
// carries it. Without it a target can land on the wrong side of spot and still read as a clean
// variant view — which is how ZTS came to be rated `sell` at a target 10% above the market.
test('valuationReadText: names which rating a target can support, in both directions', () => {
    const up = computeValuation({ method: 'pe', multiple: 32, forward_metric: 6.5, consensus_pt: 180, current_price: 160 })  // 208
    assert.match(valuationReadText('NVDA', 'pe', up), /vs the MARKET: price 160 → our target implies \+30%/)
    assert.match(valuationReadText('NVDA', 'pe', up), /ABOVE spot.*cannot support a sell/)

    const down = computeValuation({ method: 'pe', multiple: 13, forward_metric: 6.55, consensus_pt: 101.5, current_price: 95 })  // 85.15
    assert.match(valuationReadText('ZTS', 'pe', down), /BELOW spot.*cannot support a buy/)
})

test('valuationReadText: below the Street but ABOVE spot — the gap is bearish, the rating cannot be', () => {
    const r = computeValuation({ method: 'pe', multiple: 13, forward_metric: 6.55, consensus_pt: 101.5, current_price: 77.29 })
    const t = valuationReadText('ZTS', 'pe', r)
    assert.match(t, /BELOW the Street/)                       // still a variant view vs consensus…
    assert.doesNotMatch(t, /bearish variant view/)            // …but never labelled a view on the STOCK
    assert.match(t, /implies \+10\.17%/)
    assert.match(t, /cannot support a sell/)
})

test('valuationReadText: no price → says the implied return is unknown rather than staying silent', () => {
    const r = computeValuation({ method: 'pe', multiple: 32, forward_metric: 6.5, consensus_pt: 180 })
    assert.match(valuationReadText('NVDA', 'pe', r), /no price available.*do not pitch a rating/)
})

test('valuationReadText: a failed valuation explains why', () => {
    const bad = computeValuation({ method: 'pe', forward_metric: 6.5 })  // no multiple, no history
    const t = valuationReadText('X', 'pe', bad)
    assert.match(t, /Could not value X on pe/)
    assert.match(t, /multiple/)
})

// ─── the event delta read ─────────────────────────────────────────────────────

test('eventDeltaReadText: says the inputs, the band, what is open, and ends on the line to copy', () => {
    const r = computeEventDelta({ exposed_revenue_pct: 0.12, shock_pct: -0.30, shock_low: -0.2, shock_high: -0.4, incremental_margin: 0.5,
                                  persistence_quarters: 2, revenue: 50e9, net_income: 4e9, spot: 100, moved_pct: -2 })
    const t = eventDeltaReadText('xyz', r, { fy: '2027' })
    assert.match(t, /^Event delta for XYZ — this event alone, multiple held constant \(FY2027 consensus revenue \$50\.0B, net income \$4\.0B, spot 100\)/)
    assert.match(t, /12\.0% of revenue exposed × shock -30% to that line \(band -20% to -40%\) × 50% incremental margin × 2 quarter\(s\)/)
    assert.match(t, /Δ net income: -\$450M \(band -\$600M to -\$300M\)/)
    assert.match(t, /Δ price at constant multiple: -11\.3% \(band -15\.0% to -7\.5%\) → implied 88\.75/)
    assert.match(t, /Moved since the event \(vs SPY\): -2\.0% → still open: -9\.3%/)
    // The last line is the tool's own JSON, for the model to copy into the block unchanged.
    const last = t.trim().split('\n').pop()
    const j = JSON.parse(last)
    assert.equal(j.delta_price_pct, -11.25); assert.equal(j.remaining_pct, -9.25); assert.equal(j.fy, '2027')
})

test('eventDeltaReadText: the market past what the event is worth is said in words', () => {
    const r = computeEventDelta({ exposed_revenue_pct: 0.1, shock_pct: -0.2, incremental_margin: 0.5, persistence_quarters: 1,
                                  revenue: 10e9, net_income: 1e9, spot: 50, moved_pct: -9 })
    // worth −2.5%, moved −9% → remaining +6.5%: the sign flipped
    assert.match(eventDeltaReadText('A', r), /still open: \+6\.5% — the market has moved PAST what the event is worth/)
})

test('eventDeltaReadText: a loss-maker states the dollars and says why there is no percentage', () => {
    const r = computeEventDelta({ exposed_revenue_pct: 0.5, shock_pct: 0.2, incremental_margin: 0.3, persistence_quarters: 4, revenue: 1e9, net_income: -5e7, spot: 10 })
    const t = eventDeltaReadText('L', r)
    assert.match(t, /Δ net income: \$30M/)
    assert.match(t, /Δ price: n\/a — the company is loss-making/)
    assert.equal(JSON.parse(t.trim().split('\n').pop()).delta_price_pct, null)
})

test('eventDeltaReadText: a refusal names what was missing, and has no line to copy', () => {
    assert.match(eventDeltaReadText('B', computeEventDelta({ exposed_revenue_pct: 0.5 })), /not computed — exposed_revenue_pct, shock_pct, incremental_margin and persistence_quarters are all required/)
    assert.match(eventDeltaReadText('B', computeEventDelta({ exposed_revenue_pct: 0.5, shock_pct: 0.1, incremental_margin: 0.5, persistence_quarters: 1 })), /no forward revenue/)
    assert.doesNotMatch(eventDeltaReadText('B', null), /Copy this/)
})

test('compute_event_delta is registered after the two valuation tools — the cache prefix only grows at the end', () => {
    assert.deepEqual(VALUATION_TOOLS.map(t => t.name), ['get_consensus', 'compute_valuation', 'compute_event_delta'])
    const t = VALUATION_TOOLS[2]
    assert.deepEqual(t.input_schema.required, ['ticker', 'exposed_revenue_pct', 'shock_pct', 'incremental_margin', 'persistence_quarters'])
})
