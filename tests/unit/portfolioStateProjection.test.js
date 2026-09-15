import { test } from 'node:test'
import assert from 'node:assert/strict'

import { STATE_PROJECTION } from '../../services/portfolioState.service.js'

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
