import { test } from 'node:test'
import assert from 'node:assert/strict'

import { STATE_PROJECTION, _declinedChanges } from '../../services/portfolioState.service.js'

// THE PROJECTION MUST COVER EVERY FIELD THE STATE MAPPER READS.
//
// computePortfolioState reads its rows through one narrow projection and then maps them field by
// field. A field the mapper reads but the projection omits does not throw and does not fail a
// test — it reads `undefined` forever, and whatever is computed from it is silently null.
//
// That is not hypothetical. `conviction_history` was missing, so `convictionPrev` was null on every
// holding in every book, which switched OFF the conviction trigger (portfolioReview.util calls it
// the highest-signal early warning) and the "(was medium)" trend Atlas renders. snapshotConvictions
// had been writing the array on every review close the whole time. Nothing noticed, because the
// trigger's own tests feed convictionPrev in directly.
//
// So the list below is the check, not the comment. Each entry names where the field is read.
const READ_BY_THE_MAPPER = {
    id:                 'liveStates/pendingStates → ideaId (the itemId a <portfolio_update> names)',
    asset:              'liveStates/pendingStates → asset; also the sector + earnings joins',
    direction:          'liveStates → pnlPct sign, and the rendered line',
    status:             'the live/pending split (LIVE_STATUSES / PENDING_STATUSES)',
    type:               'liveStates/pendingStates → type',
    allocationRatio:    'drift vs target, and the liveAllocTotal normaliser',
    quantity:           'the authored size — rendered in every mode since the EDIT MODE block went',
    entry_conditions:   'entryConditions → what a PENDING holding is waiting on',
    stop_conditions:    'stopConditions → the tree that still binds a live holding',
    brokerOrders:       'the position match — notional, P&L, entry price',
    research_basis:     'researchBasis → the coverage gate holds its PT against our own cost',
    activatedAt:        'thesisAgeDays',
    conviction:         'conviction (current)',
    conviction_history: '_lastConviction → convictionPrev → the conviction trigger + the (was …) trend',
    rebalance_history:  '_declinedChanges → declinedChanges → the DECLINED line, so a refused change is not re-proposed',
    notes:              'the frozen per-holding thesis, rendered in review mode',
    portfolioName:      'the state\'s portfolioName',
    broker:             '_deriveWorkspace → mode + brokerLabel',
    mainAccountId:      '_deriveWorkspace → the primary account',
    accounts:           '_deriveWorkspace → the account union',
}

test('STATE_PROJECTION covers every field computePortfolioState reads', () => {
    for (const [field, readAt] of Object.entries(READ_BY_THE_MAPPER)) {
        assert.equal(STATE_PROJECTION[field], 1, `${field} is missing from STATE_PROJECTION — read at: ${readAt}`)
    }
})

// The other half of "narrow on purpose": a projection that has quietly grown a field nobody reads
// costs every review turn that carries it. A new key here is fine — add it to the map above with
// the place it is read, or take it out of the projection.
test('STATE_PROJECTION carries nothing the mapper does not read', () => {
    const extra = Object.keys(STATE_PROJECTION).filter(k => !(k in READ_BY_THE_MAPPER))
    assert.deepEqual(extra, [], `unread field(s) in STATE_PROJECTION: ${extra.join(', ')}`)
})

// ─── _declinedChanges — the refusals a review must not re-propose ────────────────
//
// originRegistry._cancelPortfolioItem appends to `rebalance_history` every time a user cancels a
// queued change, explicitly so the next review can see it. Nothing read it back until §5, which
// made this the SECOND writer-without-reader in this collection after conviction_history — and the
// consequence was the one its own comment predicted: the same trim came back the next week,
// identically, and the desk read as not listening.

const row = (over = {}) => ({ at: Date.UTC(2026, 8, 10), action: 'trim', outcome: 'cancelled', ...over })

test('_declinedChanges keeps a cancelled change', () => {
    assert.deepEqual(_declinedChanges({ rebalance_history: [row()] }),
        [{ action: 'trim', at: Date.UTC(2026, 8, 10) }])
})

// ONLY a cancel is a preference. A row that expired unexecuted says nothing about what the user
// wants — the writer records `queued` separately for exactly this reason — and reading it as a
// refusal would state an opinion to the desk that the user never held.
test('_declinedChanges drops any outcome that is not a cancel', () => {
    const rows = [row({ outcome: 'expired' }), row({ outcome: 'done' }), row({ outcome: null })]
    assert.deepEqual(_declinedChanges({ rebalance_history: rows }), [])
})

// A row with no verb names no change, so it cannot be re-proposed and has nothing to say.
test('_declinedChanges drops a row with no action', () => {
    assert.deepEqual(_declinedChanges({ rebalance_history: [row({ action: null })] }), [])
})

// The stored array holds 12; this becomes prompt text beside every holding, so it carries the
// recent refusals rather than a ledger — newest first, because that is the one that still stands.
test('_declinedChanges takes the newest four, newest first', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ at: Date.UTC(2026, 8, i + 1), action: `a${i}` }))
    assert.deepEqual(_declinedChanges({ rebalance_history: rows }).map(r => r.action), ['a5', 'a4', 'a3', 'a2'])
})

test('_declinedChanges is empty for a holding with no history, and never throws on junk', () => {
    assert.deepEqual(_declinedChanges({}), [])
    assert.deepEqual(_declinedChanges(null), [])
    assert.deepEqual(_declinedChanges({ rebalance_history: 'not an array' }), [])
})
