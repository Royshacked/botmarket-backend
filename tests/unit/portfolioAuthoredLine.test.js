import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _buildPortfolioStateSection } from '../../services/agents/portfolio.agent.service.js'

// WHAT THE HOLDING IS AUTHORED AS, as opposed to what it is currently worth: the size, and the
// condition trees. This used to live in a second block built from the ideas list the CLIENT sent
// (EDIT MODE), rendered alongside this one with a different spelling of the same holding's id. The
// block is gone; the content it carried is projected and rendered here, from the database.

const holding = (over = {}) => ({
    ideaId: 'i1', asset: 'NVDA', direction: 'long', status: 'long',
    allocationRatio: 0.4, actualWeight: 0.45, drift: 0.05, pnl: 500, pnlPct: 12,
    thesisAgeDays: 30, upcomingEarnings: null,
    quantity: null, entryConditions: [], stopConditions: [],
    ...over,
})

const state = (ideas) => ({
    portfolioName: 'Core', computedAt: 0,
    workspace: { mode: 'paper', accounts: [] },
    totalNotional: 10000, totalPnl: 500, totalPnlPct: 5,
    ideas, sectors: [],
})

test('the authored size is rendered', () => {
    const out = _buildPortfolioStateSection(state([holding({ quantity: 120 })]), false, null)
    assert.match(out, /qty 120/)
})

// A pending holding has not entered yet, so what it is WAITING ON is the whole of its state.
test('a pending holding shows the entry tree it is waiting on', () => {
    const pending = holding({
        status: 'looking', actualWeight: null, pnl: null, pnlPct: null,
        entryConditions: ['price closes above 140'], stopConditions: ['close below 120'],
    })
    const out = _buildPortfolioStateSection(state([pending]), false, null)
    assert.match(out, /entry: "price closes above 140"/)
    assert.match(out, /stop: "close below 120"/)
})

// A live holding is PAST its entry, so its entry tree is history and printing it invites the model
// to reason about a gate that has already fired. The stop still binds, so it stays.
test('a live holding shows the stop but not the entry it already cleared', () => {
    const live = holding({
        quantity: 10,
        entryConditions: ['price closes above 140'], stopConditions: ['close below 120'],
    })
    const out = _buildPortfolioStateSection(state([live]), false, null)
    assert.doesNotMatch(out, /entry: /)
    assert.match(out, /stop: "close below 120"/)
})

// Nothing authored → no dangling arrow. An empty continuation line reads as missing data.
test('a holding with nothing authored renders no continuation line at all', () => {
    const out = _buildPortfolioStateSection(state([holding()]), false, null)
    assert.doesNotMatch(out, /↳/)
})

// The same content in review mode, where it sits alongside the frozen thesis rather than replacing
// it: a review judges the holding against BOTH what was authored and why it was bought.
test('review mode renders the authored line as well as the thesis', () => {
    const live = holding({ quantity: 10, notes: 'Datacenter demand outruns supply', stopConditions: ['close below 120'] })
    const out  = _buildPortfolioStateSection(state([live]), true, null)
    assert.match(out, /qty 10/)
    assert.match(out, /stop: "close below 120"/)
    assert.match(out, /thesis: Datacenter demand outruns supply/)
})
