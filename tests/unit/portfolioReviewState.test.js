import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _buildPortfolioStateSection } from '../../services/portfolio.agent.service.js'

// The review-mode context must ground the intact/weakening/broken judgment in the FROZEN thesis
// (per-holding notes + conviction rationale). Construction/edit context must NOT carry that text.

const state = () => ({
    portfolioName: 'Core', computedAt: 0,
    workspace: { mode: 'paper', accounts: [] },
    totalNotional: 10000, totalPnl: 500, totalPnlPct: 5,
    ideas: [{
        asset: 'NVDA', direction: 'long', status: 'long',
        allocationRatio: 0.4, actualWeight: 0.45, drift: 0.05, pnl: 500, pnlPct: 12,
        thesisAgeDays: 30,
        conviction: { level: 'high', score: 8, rationale: 'AI capex supercycle intact' },
        convictionPrev: { level: 'medium' },
        notes: 'Datacenter demand outruns supply through 2027',
        upcomingEarnings: null, sector: 'Technology',
    }],
    sectors: [],
})

test('review mode renders the frozen thesis + rationale beneath the holding', () => {
    const out = _buildPortfolioStateSection(state(), true, null)
    assert.match(out, /thesis: Datacenter demand outruns supply through 2027/)
    assert.match(out, /rationale: AI capex supercycle intact/)
    assert.match(out, /intact \/ weakening \/ broken against the thesis/)   // the review instruction
})

test('construction/edit mode omits the thesis text (keeps the cached tail lean)', () => {
    const out = _buildPortfolioStateSection(state(), false, null)
    assert.doesNotMatch(out, /thesis: Datacenter/)
    assert.doesNotMatch(out, /rationale: AI capex/)
})

test('rationale identical to notes is not duplicated', () => {
    const s = state()
    s.ideas[0].notes = 'Same line'
    s.ideas[0].conviction.rationale = 'Same line'
    const out = _buildPortfolioStateSection(s, true, null)
    assert.match(out, /thesis: Same line/)
    assert.doesNotMatch(out, /rationale: Same line/)
})
