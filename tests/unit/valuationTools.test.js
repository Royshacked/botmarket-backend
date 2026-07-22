import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatConsensus, valuationReadText } from '../../services/valuation.tools.js'
import { computeValuation } from '../../services/valuation.engine.js'

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

test('valuationReadText: a failed valuation explains why', () => {
    const bad = computeValuation({ method: 'pe', forward_metric: 6.5 })  // no multiple, no history
    const t = valuationReadText('X', 'pe', bad)
    assert.match(t, /Could not value X on pe/)
    assert.match(t, /multiple/)
})
