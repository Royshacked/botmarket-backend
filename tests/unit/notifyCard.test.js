import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postCard } from '../../services/notifyCard.js'
import { notifyManualExit, notifyManualEntry } from '../../services/manualNotify.service.js'
import { notifySetupEntryConfirm, notifyIdeaEntryConfirm } from '../../services/tradeNotify.service.js'
import { notifyCoverageEvent } from '../../services/coverageNotify.service.js'

// The one rule these tests exist to hold: POSTING A CARD NEVER THROWS.
//
// A card is an alert ABOUT a state change, never part of it. By the time we post, the state is
// already written — an idea is 'hit', a position is 'awaiting_manual_close'. A throw at that point
// cannot undo the write; it can only abort the rest of the handler.
//
// That was a live bug. positionMonitor persists `orderState: 'awaiting_manual_close'` and sets a
// same-tick guard, THEN posts the manual-exit card. notifyManualExit called postBotCard bare, so a
// chat-service hiccup threw — leaving the position marked "awaiting user close", with the persisted
// guard suppressing every later retry, and no card ever delivered. The user simply never learned
// their stop had fired.

// postBotCard is reached through the module graph, so failure is simulated by feeding postCard a
// card whose own serialization explodes — the same shape as a transport failure.
const EXPLODING = {
    userId: 'u1',
    get content() { throw new Error('chat service unavailable') },
}

test('a delivery failure returns null instead of throwing', async () => {
    // The contract the whole category rests on.
    assert.equal(await postCard(EXPLODING, { tag: 'T', log: '[test]' }), null)
})

test('a card with no owner is skipped, not treated as an error', async () => {
    // Builders legitimately return a null userId for an entity that lost its user.
    assert.equal(await postCard({ userId: null, content: 'x' }, { tag: 'T' }), null)
    assert.equal(await postCard(null, { tag: 'T' }), null)
    assert.equal(await postCard(undefined, { tag: 'T' }), null)
})

test('postCard works with no context at all', async () => {
    assert.equal(await postCard(null), null)
})

// ─── Every notifier inherits the rule ─────────────────────────────────────────

test('REGRESSION: a manual EXIT notify never throws into positionMonitor', async () => {
    // The bug above. positionMonitor has already written the guard by this point, so a throw here
    // strands the position permanently.
    await assert.doesNotReject(() => notifyManualExit('u1', {
        legs: [{ ideaId: 'i1', asset: 'NVDA', direction: 'long' }], reason: 'stop',
    }))
})

test('a manual ENTRY notify never throws into the monitor tick', async () => {
    // The caller patches status→'hit' + orderState→'awaiting_manual_fill' BEFORE posting.
    await assert.doesNotReject(() => notifyManualEntry('u1', {
        legs: [{ ideaId: 'i1', asset: 'NVDA', direction: 'long' }],
    }))
})

test('an entry-confirm notify never throws into the monitor that sent it', async () => {
    await assert.doesNotReject(() => notifyIdeaEntryConfirm({ id: 'i1', userId: 'u1', asset: 'NVDA', direction: 'long' }))
    await assert.doesNotReject(() => notifySetupEntryConfirm(
        { id: 's1', userId: 'u1', asset: 'NVDA', direction: 'long' },
        { verdict: 'wait', warning: 'tape is soft' },
    ))
})

test('a coverage notify never throws into the monitor loop', async () => {
    await assert.doesNotReject(() => notifyCoverageEvent({ symbol: 'NVDA', userId: 'u1' }, { state: 'target_hit' }))
})

test('notifiers with nothing to send resolve to null rather than erroring', async () => {
    // Empty legs / missing owner are ordinary states, not failures.
    assert.equal(await notifyManualEntry('u1', { legs: [] }), null)
    assert.equal(await notifyManualExit(null, { legs: [{ asset: 'X' }] }), null)
    assert.equal(await notifyIdeaEntryConfirm({ id: 'i1', asset: 'NVDA' }), null, 'no userId → nothing posted')
})
