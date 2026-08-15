import { test } from 'node:test'
import assert from 'node:assert/strict'
import { manageSetup, dismissSetupCard, toExecutionProposal, FRACTION_PCT } from '../../services/talos.handoff.service.js'

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

test('toExecutionProposal: Talos speaks stop/fraction, the executor speaks new_stop/size_pct', () => {
    assert.deepEqual(toExecutionProposal('move_stop', { stop: 118, why: 'structure' }),
        { new_stop: 118, ref: 'structure' })
    assert.deepEqual(toExecutionProposal('take_partial', { fraction: 'half' }), { size_pct: 50 })
    assert.equal(toExecutionProposal('take_partial', { fraction: 'third' }).size_pct, FRACTION_PCT.third)
    assert.equal(toExecutionProposal('take_partial', { fraction: 'two_thirds' }).size_pct, FRACTION_PCT.two_thirds)
    assert.deepEqual(toExecutionProposal('exit_now', null), {})
})

test('toExecutionProposal: a proposal already in the shared dialect passes through', () => {
    assert.deepEqual(toExecutionProposal('move_stop', { new_stop: 120 }), { new_stop: 120, ref: null })
    assert.equal(toExecutionProposal('take_partial', { size_pct: 25 }).size_pct, 25)
})

test('toExecutionProposal: a missing level resolves to null, never to a guess', () => {
    assert.equal(toExecutionProposal('move_stop', {}).new_stop, null)
    assert.equal(toExecutionProposal('move_stop', { stop: 'soon' }).new_stop, null)
    assert.equal(toExecutionProposal('take_partial', { fraction: 'most_of_it' }).size_pct, null)
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

test('take_partial accept → closes the fraction Talos named, in position units', async () => {
    const db = fakeDb(inPosSetup({ pending_action: { verdict: 'take_partial', proposal: { fraction: 'third' } } }))
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

test('a BARE let_run is not an accept — it is a decision not to act', async () => {
    // On the menu now, but only as the carrier for a new target. Without a level there is nothing
    // to place: the position is already doing what a bare let_run describes.
    const ps  = { pending_action: { verdict: 'let_run', proposal: null } }
    const res = await manageSetup('setup_NVDA_1', 'u1', 'let_run', deps(fakeDb(inPosSetup(ps))))
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'bad_proposal')
})

test('a let_run carrying a level moves the target OUT, and the wake level travels with it', async () => {
    // Principle 3 of the TP window: the move has more in it than the plan assumed. The executor
    // amends the resting limit; the ladder Talos wakes on is this desk's, and nothing else moves it.
    let amended = null
    const db = fakeDb(inPosSetup({
        // Asked once at 128 already, window 2 wide, limit resting at 130.
        targets: [{ price: 128, resting: 130, hit_at: '2026-08-15T10:00:00.000Z' }],
        pending_action: { verdict: 'let_run', proposal: { tp: 141, why: 'measured move' } },
    }))
    const res = await manageSetup('setup_NVDA_1', 'u1', 'let_run',
        deps(db, { amendOrder: async (_b, _u, _a, _o, fields) => { amended = fields } }))

    assert.equal(res.ok, true)
    assert.equal(amended.limitPrice, 141, 'the resting limit follows')

    const ladder = db.updates.map(u => u.$set?.['position_state.targets']).filter(Boolean).at(-1)
    assert.deepEqual(ladder, [{ price: 139, resting: 141, hit_at: null }],
        'breadth of 2 carried to the new level, and re-armed so the conversation happens again there')
})

test('on a staged ladder the window moves on the rung whose order is actually amended', async () => {
    // The executor amends whichever tp order positionManage.workingExit finds; if the ladder guessed
    // "nearest un-asked" instead, the two would part company — one rung's window would move while a
    // different rung's order did, leaving a target pointing at a level nothing rests on.
    const setup = inPosSetup({
        targets: [
            { price: 126, resting: 128, hit_at: null },   // nearest un-asked — NOT the resting order
            { price: 128, resting: 130, hit_at: null },   // the one at 130, which is what is working
        ],
        pending_action: { verdict: 'let_run', proposal: { tp: 140 } },
    })
    const db  = fakeDb(setup)
    const res = await manageSetup('setup_NVDA_1', 'u1', 'let_run', deps(db))

    assert.equal(res.ok, true)
    const ladder = db.updates.map(u => u.$set?.['position_state.targets']).filter(Boolean).at(-1)
    assert.deepEqual(ladder, [
        { price: 126, resting: 128, hit_at: null },
        { price: 138, resting: 140, hit_at: null },
    ], 'the 130 rung moved, breadth intact; the untouched rung is left exactly alone')
})

test('a failed amend moves no ladder — the window never drifts away from the order', async () => {
    // With nothing resting there is nothing to amend, so the executor fails. The ladder must not
    // move anyway: a window pointing at a level no order sits on is worse than an unmoved one.
    const setup = inPosSetup({
        targets: [{ price: 128, resting: 130, hit_at: null }],
        pending_action: { verdict: 'let_run', proposal: { tp: 140 } },
    }, { exitOrders: [] })
    const db  = fakeDb(setup)
    const res = await manageSetup('setup_NVDA_1', 'u1', 'let_run', deps(db))

    assert.equal(res.ok, false)
    assert.equal(db.updates.some(u => u.$set?.['position_state.targets']), false)
})

test('a manual book has no orders to read, so the ladder moves on the rung under discussion', async () => {
    // The fallback path: manual places nothing, so there is no amended level to match against — but
    // the user is still being told to move their target, and the ladder has to follow.
    const setup = inPosSetup({
        targets: [{ price: 128, resting: 130, hit_at: null }],
        pending_action: { verdict: 'let_run', proposal: { tp: 140 } },
    }, { broker: 'manual', exitOrders: [] })
    const db  = fakeDb(setup)
    const res = await manageSetup('setup_NVDA_1', 'u1', 'let_run', deps(db))

    assert.equal(res.manual, true)
    const ladder = db.updates.map(u => u.$set?.['position_state.targets']).filter(Boolean).at(-1)
    assert.deepEqual(ladder, [{ price: 138, resting: 140, hit_at: null }])
})

test('a let_run that cancels the target outright is an action, not a missing level', async () => {
    let cancelled = false
    const ps = { pending_action: { verdict: 'let_run', proposal: { cancel_tp: true } } }
    const res = await manageSetup('setup_NVDA_1', 'u1', 'let_run',
        deps(fakeDb(inPosSetup(ps)), { cancelOrder: async () => { cancelled = true } }))

    assert.equal(res.ok, true)
    assert.equal(cancelled, true)
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
