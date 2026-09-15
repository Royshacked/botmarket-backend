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

// Edit context carries the ids TOO, since 2026-09-15. It did not have to before, because the EDIT
// MODE block rendered the same holdings from the client's ideas list with its own `ideaId:` spelling
// — two descriptions of one book in one prompt, one of them client-supplied and the other telling
// the model it was the only id source. That block is gone, so this is the only place an itemId can
// come from in any mode, and an edit names a holding exactly as a review does.
test('edit context carries the ids too — it is the only place they come from now', () => {
    const out = _buildPortfolioStateSection(state(), false, null)
    assert.match(out, /\[708121b6-4e9c-4460-bbf2-21416baeb960\] NVDA/)
    assert.match(out, /ONLY description of this book/)
    assert.match(out, /never compose one from the ticker/)
})

// The frozen thesis stays review-only: that is about keeping the cached tail lean, and it was never
// the reason the ids were withheld.
test('edit context still omits the frozen thesis', () => {
    const out = _buildPortfolioStateSection(state(), false, null)
    assert.doesNotMatch(out, /thesis:/)
})

// A row with no id must not render an empty [] — an id-shaped hole reads as a real handle.
test('a row without an id renders no bracket at all', () => {
    const s = state()
    delete s.ideas[0].ideaId
    const out = _buildPortfolioStateSection(s, true, null)
    assert.doesNotMatch(out, /\[\] *NVDA/)
    assert.match(out, /NVDA/)
})
