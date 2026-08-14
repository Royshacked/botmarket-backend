import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _buildPortfolioStateSection } from '../../services/agents/portfolio.agent.service.js'

// A review's output is a set of actions naming WHICH holding each one acts on, carried as `itemId`
// in <portfolio_update>. Those ids used to appear ONLY in the EDIT MODE block, which is built from
// a holdings list the CLIENT sends — so when that list arrived empty (a social-chat card click
// landing before the ideas list had loaded) the review still read perfectly, because this state
// block comes from Mongo, and Atlas filled the ids in from nowhere. Every accepted change then came
// back not_found and the user got a red banner on a review that had gone fine.
//
// The ids are on these rows already (portfolioState stamps `ideaId` off the document). Rendering
// them in review is what makes the model's only source of an itemId the database's own answer.

const state = () => ({
    portfolioName: 'Core', computedAt: 0,
    workspace: { mode: 'paper', accounts: [] },
    totalNotional: 10000, totalPnl: 500, totalPnlPct: 5,
    ideas: [
        {
            ideaId: '708121b6-4e9c-4460-bbf2-21416baeb960',
            asset: 'NVDA', direction: 'long', status: 'long',
            allocationRatio: 0.4, actualWeight: 0.45, drift: 0.05, pnl: 500, pnlPct: 12,
            thesisAgeDays: 30, upcomingEarnings: null,
        },
        {
            ideaId: 'ca26ecc8-b1b8-440a-b021-ae2a164bb5a5',
            asset: 'SPGI', direction: 'long', status: 'waiting',
            allocationRatio: 0.2, actualWeight: null, upcomingEarnings: null,
        },
    ],
    sectors: [],
})

test('review mode renders each holding itemId, live and pending alike', () => {
    const out = _buildPortfolioStateSection(state(), true, null)
    assert.match(out, /\[708121b6-4e9c-4460-bbf2-21416baeb960\] NVDA/)
    assert.match(out, /\[ca26ecc8-b1b8-440a-b021-ae2a164bb5a5\] SPGI/)
})

test('review mode tells the model the bracketed id is the ONLY source of an itemId', () => {
    const out = _buildPortfolioStateSection(state(), true, null)
    assert.match(out, /ONLY source of itemId/)
    assert.match(out, /never compose one from the ticker/)
})

// Construction/edit context is prompt-cached and does not author a <portfolio_update> off these
// rows — the EDIT MODE block carries the ids there. Keeping them out holds that tail lean, which is
// the same reason the frozen thesis is review-only.
test('non-review context leaves the ids off', () => {
    const out = _buildPortfolioStateSection(state(), false, null)
    assert.doesNotMatch(out, /\[708121b6-4e9c-4460-bbf2-21416baeb960\]/)
    assert.match(out, /NVDA/)
})

// A row with no id must not render an empty [] — an id-shaped hole reads as a real handle.
test('a row without an id renders no bracket at all', () => {
    const s = state()
    delete s.ideas[0].ideaId
    const out = _buildPortfolioStateSection(s, true, null)
    assert.doesNotMatch(out, /\[\] *NVDA/)
    assert.match(out, /NVDA/)
})
