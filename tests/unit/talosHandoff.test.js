import { test } from 'node:test'
import assert from 'node:assert/strict'
import { manageSetup, dismissSetupCard, disarmSetup, toExecutionProposal } from '../../services/talos.handoff.service.js'

// The setup half of in-position management. Talos has written `position_state.pending_action` since
// Phase 5; until this service there was nowhere to say yes, so a proposal died on the card.
//
// A setup holds its OWN broker linkage (execution writes brokerOrders/exitOrders onto the setup
// doc), unlike a call — which materializes an idea and hangs the position off that. These fixtures
// are the proof of that difference: there is no second doc here.

function inPosSetup(psExtra = {}, extra = {}) {
    return {
        id: 'setup_NVDA_1', userId: 'u1', kind: 'setup', asset: 'NVDA', direction: 'long',
        broker: 'paper', accounts: ['p1'], mainAccountId: 'p1', status: 'long', quantity: 100,
        brokerOrders: [{ broker: 'paper', accountId: 'p1', positionId: 'pos1', quantity: 100 }],
        exitOrders: [
            { leg: 'stop', status: 'working', orderId: 'so1', accountId: 'p1', broker: 'paper', price: 112 },
            { leg: 'tp',   status: 'working', orderId: 'to1', accountId: 'p1', broker: 'paper', price: 130 },
        ],
        position_state: {
            entry: { fill_price: 118, intended: 118, direction: 'long', size: 100 },
            stop:  { current: 112, initial: 112 },
            targets: [], taken: [],
            pending_action: { verdict: 'move_stop', proposal: { stop: 118, why: 'structure defended' } },
            ...psExtra,
        },
        ...extra,
    }
}

function fakeDb(setup) {
    const updates = []
    return { updates, collection: () => ({ findOne: async () => setup, updateOne: async (_q, u) => { updates.push(u) } }) }
}

function deps(db, over = {}) {
    return {
        getDb: async () => db,
        // The venue is OPEN unless a test says otherwise. Stated rather than inherited: the real
        // gate reads the live clock, so a suite that let it through would pass by day and queue
        // everything by night.
        deferIfClosed: async () => ({ deferred: false }),
        findOpenPosition: async () => ({ volume: 100 }),
        closePosition: async () => {},
        amendOrder: async () => {},
        cancelOrder: async () => {},
        syncExit: async () => {},
        notifyManage: async () => {},
        ...over,
    }
}

// ── The dialect (pure) ────────────────────────────────────────────────────────

test('toExecutionProposal: Talos speaks stop/why and leg/size_pct, the executor speaks new_stop/size_pct', () => {
    assert.deepEqual(toExecutionProposal('move_stop', { stop: 118, why: 'structure' }),
        { new_stop: 118, ref: 'structure' })
    // The monitor resolved the watched target's own size into a share of the original position.
    assert.deepEqual(toExecutionProposal('take_partial', { leg: 't2', quantity: 50, size_pct: 50 }), { size_pct: 50 })
    assert.deepEqual(toExecutionProposal('exit_now', null), {})
    assert.deepEqual(toExecutionProposal('let_run', { new_tp: 141 }), {}, 'let_run is not a verb any more')
})

test('toExecutionProposal: a proposal already in the shared dialect passes through', () => {
    assert.deepEqual(toExecutionProposal('move_stop', { new_stop: 120 }), { new_stop: 120, ref: null })
    assert.equal(toExecutionProposal('take_partial', { size_pct: 25 }).size_pct, 25)
})

test('toExecutionProposal: a missing level resolves to null, never to a guess', () => {
    assert.equal(toExecutionProposal('move_stop', {}).new_stop, null)
    assert.equal(toExecutionProposal('move_stop', { stop: 'soon' }).new_stop, null)
    assert.equal(toExecutionProposal('take_partial', { fraction: 'third' }).size_pct, null, 'the old fraction dialect is not translated')
})

// ── Accept ────────────────────────────────────────────────────────────────────

test('move_stop accept → amends the native stop, clears the card, advances stop.current', async () => {
    const db = fakeDb(inPosSetup())
    let amended = null, synced = null
    const res = await manageSetup('setup_NVDA_1', 'u1', 'move_stop', deps(db, {
        amendOrder: async (_b, _u, _a, orderId, fields) => { amended = { orderId, fields }; return { orderId: 'so2' } },
        syncExit:   async (_id, _acct, leg, patch) => { synced = { leg, patch } },
    }))

    assert.equal(res.ok, true)
    assert.deepEqual(amended, { orderId: 'so1', fields: { stopPrice: 118 } })
    assert.deepEqual(synced, { leg: 'stop', patch: { price: 118, orderId: 'so2' } })
    const u = db.updates[0]
    assert.equal(u.$set['position_state.pending_action'], null)
    assert.equal(u.$set['position_state.stop.current'], 118)
    assert.equal(u.$set['position_state.phase'], 'breakeven')   // 118 == entry
})

test("take_partial accept → closes the watched leg's size, in position units", async () => {
    const db = fakeDb(inPosSetup({ pending_action: { verdict: 'take_partial', proposal: { leg: 't1', quantity: 33.33, size_pct: 33.33 } } }))
    let closed = null
    const res = await manageSetup('setup_NVDA_1', 'u1', 'take_partial', deps(db, {
        closePosition: async (_b, _u, _a, _p, opts) => { closed = opts },
    }))

    assert.equal(res.ok, true)
    assert.equal(closed.quantity, 33.33)     // a third of 100, capped at what's live
    assert.ok(db.updates[0].$push['position_state.taken'])
})

test('exit_now works bare — getting flat is always the user\'s to choose', async () => {
    const db = fakeDb(inPosSetup({ pending_action: null }))
    let called = false
    const res = await manageSetup('setup_NVDA_1', 'u1', 'exit_now', deps(db, {
        closePosition: async () => { called = true },
    }))
    assert.equal(res.ok, true)
    assert.equal(called, true)
})

test('accepting a verb Talos did not propose is refused', async () => {
    const res = await manageSetup('setup_NVDA_1', 'u1', 'take_partial', deps(fakeDb(inPosSetup())))
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'no_pending_action')
})

// ── The hours gate ────────────────────────────────────────────────────────────
// Accepting a card is the LAST unguarded path to a broker. Closing the monitoring hole stopped new
// cards appearing off-hours; it did nothing about one posted before the close and tapped at 02:00.

test('an accept on a shut venue is QUEUED, never sent', async () => {
    // On paper this is the one that bites: exitMarkPrice degrades to the day close on purpose, so a
    // partial at 02:00 "fills" at a price nobody could have traded and lands on the ledger as real.
    let touched = false
    const db  = fakeDb(inPosSetup())
    const res = await manageSetup('setup_NVDA_1', 'u1', 'move_stop', deps(db, {
        deferIfClosed: async () => ({ deferred: true, ok: true, id: 'pa_1', nextOpenMs: 111 }),
        amendOrder: async () => { touched = true },
    }))

    assert.equal(res.ok, true, 'the decision was taken — it is queued, not refused')
    assert.equal(res.deferred, true)
    assert.equal(res.queuedId, 'pa_1')
    assert.equal(touched, false, 'nothing reached the broker')
})

test('the queued row carries the VERB as its type, so one accept cannot swallow another', async () => {
    // enqueue dedupes on (user, entity, action.type). Folding every verb into one 'manage' type
    // would let a queued move_stop absorb the exit_now that came after it.
    let queued = null
    const db = fakeDb(inPosSetup())
    await manageSetup('setup_NVDA_1', 'u1', 'move_stop', deps(db, {
        deferIfClosed: async (p) => { queued = p; return { deferred: true, ok: true, id: 'pa_1' } },
    }))

    assert.equal(queued.action.type, 'move_stop')
    assert.equal(queued.action.proposal.new_stop, 118, 'and the translated proposal, ready to replay')
    assert.equal(queued.origin.entityId, 'setup_NVDA_1')
    assert.equal(queued.queuedBy, 'user', 'a discretionary decision — the list may offer to drop it')
})

test('a deferred accept leaves the proposal on the card', async () => {
    // Clearing it would take the decision off the position while nothing had been done to it.
    const db = fakeDb(inPosSetup())
    await manageSetup('setup_NVDA_1', 'u1', 'move_stop', deps(db, {
        deferIfClosed: async () => ({ deferred: true, ok: true, id: 'pa_1' }),
    }))
    assert.equal(db.updates.some(u => 'position_state.pending_action' in (u.$set ?? {})), false)
})

test('a queue write that FAILS refuses the accept rather than reporting success', async () => {
    // The market is shut either way, so executing is wrong; losing the row silently is worse.
    const db  = fakeDb(inPosSetup())
    const res = await manageSetup('setup_NVDA_1', 'u1', 'move_stop', deps(db, {
        deferIfClosed: async () => ({ deferred: true, ok: false, reason: 'enqueue_failed' }),
    }))
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'enqueue_failed')
})

test('a MANUAL book is never gated — it places no orders to gate', async () => {
    let asked = false
    const db  = fakeDb(inPosSetup({}, { broker: 'manual' }))
    const res = await manageSetup('setup_NVDA_1', 'u1', 'move_stop', deps(db, {
        deferIfClosed: async () => { asked = true; return { deferred: true, ok: true, id: 'x' } },
    }))
    assert.equal(res.manual, true)
    assert.equal(asked, false, 'its card is an instruction, not an execution')
})

// ── The verbs that are NOT accepts ────────────────────────────────────────────

test('add_leg is refused with confirm_order — that leg is placed by confirming its order', async () => {
    const db  = fakeDb(inPosSetup({ pending_action: { verdict: 'add_leg', proposal: { quantity: 50 } } }))
    let closed = false
    const res = await manageSetup('setup_NVDA_1', 'u1', 'add_leg', deps(db, { closePosition: async () => { closed = true } }))

    assert.equal(res.ok, false)
    assert.equal(res.reason, 'confirm_order')
    assert.equal(closed, false)
    assert.equal(db.updates.length, 0, 'nothing was written — the pending ORDER is still the truth')
})

test('let_run is off the menu — moving a target out is an edit of the plan, not a monitor act', async () => {
    const ps  = { pending_action: { verdict: 'let_run', proposal: { tp: 141 } } }
    const res = await manageSetup('setup_NVDA_1', 'u1', 'let_run', deps(fakeDb(inPosSetup(ps))))
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'bad_action')
})

test('an off-menu verb is refused before anything is loaded', async () => {
    const res = await manageSetup('setup_NVDA_1', 'u1', 'frobnicate', deps(fakeDb(inPosSetup())))
    assert.equal(res.reason, 'bad_action')
})

// ── Guards ────────────────────────────────────────────────────────────────────

test('a setup that is not in a position has no position to manage', async () => {
    const res = await manageSetup('setup_NVDA_1', 'u1', 'move_stop', deps(fakeDb(inPosSetup({}, { status: 'looking' }))))
    assert.equal(res.reason, 'not_in_position')
})

test('another user\'s setup is forbidden', async () => {
    const res = await manageSetup('setup_NVDA_1', 'u2', 'move_stop', deps(fakeDb(inPosSetup())))
    assert.equal(res.reason, 'forbidden')
})

test('a stop move with no level never reaches the broker, and the card stays pending', async () => {
    const db = fakeDb(inPosSetup({ pending_action: { verdict: 'move_stop', proposal: { why: 'it feels wrong' } } }))
    let amended = false
    const res = await manageSetup('setup_NVDA_1', 'u1', 'move_stop', deps(db, { amendOrder: async () => { amended = true } }))

    assert.equal(res.reason, 'bad_proposal')
    assert.equal(amended, false)
    assert.equal(db.updates.length, 0, 'the card is NOT cleared — the user declined nothing')
})

test('no linked broker position → refused rather than silently doing nothing', async () => {
    const res = await manageSetup('setup_NVDA_1', 'u1', 'move_stop', deps(fakeDb(inPosSetup({}, { brokerOrders: [] }))))
    assert.equal(res.reason, 'no_position_link')
})

// ── Manual mode + already-flat ────────────────────────────────────────────────

test('manual mode notifies the instruction in TALOS\'s own words, and records the intent', async () => {
    const db = fakeDb(inPosSetup({}, { broker: 'manual' }))
    let card = null
    const res = await manageSetup('setup_NVDA_1', 'u1', 'move_stop', deps(db, { notifyManage: async (_s, c) => { card = c } }))

    assert.equal(res.ok, true)
    assert.equal(res.manual, true)
    // The RAW proposal — the card's copy is written in the desk's vocabulary, not the executor's.
    assert.deepEqual(card.proposal, { stop: 118, why: 'structure defended' })
    assert.equal(db.updates[0].$set['position_state.stop.current'], 118)
})

test('already flat at the broker → clear the card, let the reconciler close it out', async () => {
    const db  = fakeDb(inPosSetup())
    const res = await manageSetup('setup_NVDA_1', 'u1', 'move_stop', deps(db, { findOpenPosition: async () => null }))

    assert.equal(res.ok, true)
    assert.equal(res.alreadyFlat, true)
    assert.equal(db.updates[0].$set['position_state.pending_action'], null)
})

test('a broker that cannot be reached is not treated as a completed action', async () => {
    const db  = fakeDb(inPosSetup())
    const res = await manageSetup('setup_NVDA_1', 'u1', 'move_stop', deps(db, {
        findOpenPosition: async () => { throw new Error('socket closed') },
    }))
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'broker_unreachable')
    assert.equal(db.updates.length, 0)
})

// ── Dismiss ───────────────────────────────────────────────────────────────────

test('dismiss clears the card and leaves the position running', async () => {
    const db  = fakeDb(inPosSetup())
    const res = await dismissSetupCard('setup_NVDA_1', 'u1', deps(db))

    assert.equal(res.ok, true)
    assert.equal(res.dismissed, 'card')
    assert.deepEqual(db.updates[0], { $set: { 'position_state.pending_action': null } })
    assert.equal(db.updates[0].$set.status, undefined, 'dismissing a CARD must never close the setup')
})

test('dismiss on a setup with no position is refused rather than closing anything', async () => {
    const db  = fakeDb(inPosSetup({}, { status: 'looking' }))
    const res = await dismissSetupCard('setup_NVDA_1', 'u1', deps(db))
    assert.equal(res.reason, 'not_in_position')
    assert.equal(db.updates.length, 0)
})

// ── Disarm ────────────────────────────────────────────────────────────────────

function hitLimitSetup(extra = {}) {
    return {
        id: 'setup_NVDA_1', userId: 'u1', kind: 'setup', asset: 'NVDA', direction: 'long',
        broker: 'paper', accounts: ['p1'], mainAccountId: 'p1',
        status: 'hit', entry_mode: 'limit',
        orderState: 'placed',
        brokerOrders: [{ broker: 'paper', accountId: 'p1', orderId: 'ord1', quantity: 100 }],
        ...extra,
    }
}

test('disarm cancels the broker order and returns the setup to waiting', async () => {
    let cancelled = null
    const db  = fakeDb(hitLimitSetup())
    const res = await disarmSetup('setup_NVDA_1', 'u1', deps(db, {
        cancelOrder:  async (broker, userId, acct, orderId) => { cancelled = orderId },
        notifyDisarm: async () => {},
    }))

    assert.equal(res.ok, true)
    assert.equal(cancelled, 'ord1')
    assert.equal(db.updates[0].$set.status, 'waiting')
    assert.equal(db.updates[0].$set.orderState, null)
    assert.equal(db.updates[0].$set.brokerOrders, null)
})

test('disarm with no placed order skips the broker cancel but still disarms', async () => {
    let cancelled = false
    const db  = fakeDb(hitLimitSetup({ orderState: 'awaiting_confirm', brokerOrders: [] }))
    const res = await disarmSetup('setup_NVDA_1', 'u1', deps(db, {
        cancelOrder:  async () => { cancelled = true },
        notifyDisarm: async () => {},
    }))

    assert.equal(res.ok, true)
    assert.equal(cancelled, false, 'no broker call when order was not yet placed')
    assert.equal(db.updates[0].$set.status, 'waiting')
})

test('a filled limit order (positionId set) is not canceled — only unfilled links are', async () => {
    let cancelledIds = []
    const db = fakeDb(hitLimitSetup({
        brokerOrders: [
            { broker: 'paper', accountId: 'p1', orderId: 'ord-filled', positionId: 'pos1', quantity: 100 },
            { broker: 'paper', accountId: 'p1', orderId: 'ord-resting', quantity: 50 },
        ],
    }))
    await disarmSetup('setup_NVDA_1', 'u1', deps(db, {
        cancelOrder:  async (_b, _u, _a, id) => { cancelledIds.push(id) },
        notifyDisarm: async () => {},
    }))
    assert.deepEqual(cancelledIds, ['ord-resting'], 'the filled link must never be canceled')
})

test('disarm on a non-limit or non-hit setup is refused', async () => {
    const conditional = hitLimitSetup({ entry_mode: 'conditional' })
    assert.equal((await disarmSetup('setup_NVDA_1', 'u1', deps(fakeDb(conditional), { notifyDisarm: async () => {} }))).reason, 'not_a_pending_limit')

    const looking = hitLimitSetup({ status: 'looking' })
    assert.equal((await disarmSetup('setup_NVDA_1', 'u1', deps(fakeDb(looking), { notifyDisarm: async () => {} }))).reason, 'not_a_pending_limit')
})

test('another user cannot disarm a limit setup', async () => {
    const res = await disarmSetup('setup_NVDA_1', 'u2', deps(fakeDb(hitLimitSetup()), { notifyDisarm: async () => {} }))
    assert.equal(res.reason, 'forbidden')
})
