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

// ─── What the user already turned down ──────────────────────────────────────────
//
// A review proposes from the book's CURRENT STATE, which has no memory of a change the user queued
// and then cancelled — so the same trim came back the next week, identically, and the desk read as
// not listening. originRegistry._cancelPortfolioItem has been recording every refusal on the
// holding since the off-hours queue shipped, explicitly so the next review could see it, and
// nothing read it back: the second writer-without-reader found in this collection, after
// conviction_history.

// The renderer reads the MAPPED field; _declinedChanges (portfolioState) is what turns the stored
// rebalance_history into it, and has its own tests beside the projection.
const declined = (...rows) => holding({ declinedChanges: rows })

test('a change the user cancelled is shown to the review', () => {
    const s = declined({ at: Date.UTC(2026, 8, 10), action: 'trim', outcome: 'cancelled' })
    const out = _buildPortfolioStateSection(state([s]), true, null)
    assert.match(out, /DECLINED by the user: trim \(2026-09-10\)/)
})

// A non-cancel row never reaches the renderer — _declinedChanges filters it out — so the row simply
// has nothing to render. The filtering itself is asserted at the mapper.
test('nothing declined → no line, even with a history behind it', () => {
    const s = holding({ declinedChanges: [] })   // _declinedChanges dropped the non-cancel row
    assert.doesNotMatch(_buildPortfolioStateSection(state([s]), true, null), /DECLINED/)
})

test('a holding with no history renders no line', () => {
    assert.doesNotMatch(_buildPortfolioStateSection(state([holding()]), true, null), /DECLINED/)
})

// Edit context too: an edit proposes changes exactly as a review does, so it needs the same memory.
test('the refusal is shown in edit context as well as review', () => {
    const s = declined({ at: Date.UTC(2026, 8, 10), action: 'exit', outcome: 'cancelled' })
    assert.match(_buildPortfolioStateSection(state([s]), false, null), /DECLINED by the user: exit/)
})
