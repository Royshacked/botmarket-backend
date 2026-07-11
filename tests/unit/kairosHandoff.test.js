import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    deriveMode, buildIdeaFromCall, buildPositionState, applyEditPatch, confirmCall, editCall, dismissCall,
    manageCall, _resolveMainLink, _workingExit, _partialQty,
} from '../../services/kairos.handoff.service.js'

function readyCall(extra = {}) {
    return {
        id: 'call_TSLA_x', user_id: 'u1', asset: 'TSLA', asset_class: 'equity', bias: 'long',
        broker: 'paper', accounts: ['paper-u1'], main_account_id: 'paper-u1',
        status: 'ready',
        monitor_state: { last_assessment: { verdict: 'enter', proposal: {
            entry: 248.3, stop: 245.2, stop_ref: 'rl1', take_profit: [{ price: 252, ref: 'rl2' }], size: 220, rr: 2.1, rationale: 'reclaim',
        } } },
        ...extra,
    }
}

// Fake db: findOne always returns `call`; updateOne records the $set patch.
function fakeDb(call) {
    const updates = []
    return { updates, collection: () => ({
        findOne:   async () => call,
        updateOne: async (_q, u) => { updates.push(u.$set) },
    }) }
}

function baseDeps(db, over = {}) {
    return {
        getDb:              async () => db,
        saveIdea:           async () => ({ ok: true, idea: { id: 'idea1', pendingOrder: { plan: [{ broker: 'paper', accountId: 'p1', quantity: 220, type: 'market' }] } } }),
        placeOrdersForIdea: async () => ({ ok: true }),
        notifyManualEntry:  async () => ({}),
        entryLegFromIdea:   (idea) => ({ ideaId: idea.id, asset: 'TSLA' }),
        markIdeaOwned:      async () => ({}),
        ...over,
    }
}

// ── deriveMode ─────────────────────────────────────────────────────────────
test('deriveMode: broker → mode', () => {
    assert.equal(deriveMode('ctrader'), 'live')
    assert.equal(deriveMode('paper'), 'paper')
    assert.equal(deriveMode('manual'), 'manual')
    assert.equal(deriveMode('nope'), null)
    assert.equal(deriveMode(undefined), null)
})

// ── buildIdeaFromCall ──────────────────────────────────────────────────────
test('buildIdeaFromCall: maps proposal → immediate market idea with NATIVE touch exits', () => {
    const idea = buildIdeaFromCall(readyCall(), readyCall().monitor_state.last_assessment.proposal)
    assert.equal(idea.asset, 'TSLA')
    assert.equal(idea.direction, 'long')
    assert.equal(idea.quantity, 220)
    assert.equal(idea.immediate, true)
    // Stop + FINAL target as `touch` leaves (rest as native broker orders — survive the Minos skip).
    assert.deepEqual(idea.stop_conditions, [{ condition: 'price touches 245.2', type: 'touch', timeframe: null }])
    assert.deepEqual(idea.tp_conditions,   [{ condition: 'price touches 252',   type: 'touch', timeframe: null }])
    assert.equal(idea.stop_loss, undefined)   // no bare-string exits (those resolve to NO tree)
    assert.equal(idea.take_profit, undefined)
    assert.deepEqual(idea.accounts, ['paper-u1'])
    assert.equal(idea.mainAccountId, 'paper-u1')
})
test('buildIdeaFromCall: native TP is the FINAL target (intermediates are discretionary)', () => {
    const idea = buildIdeaFromCall(readyCall(), { stop: 245, take_profit: [{ price: 252 }, { price: 256 }, { price: 260 }], size: 10 })
    assert.deepEqual(idea.tp_conditions, [{ condition: 'price touches 260', type: 'touch', timeframe: null }])
})
test('buildIdeaFromCall: short bias flips direction', () => {
    const idea = buildIdeaFromCall(readyCall({ bias: 'short' }), { stop: 250, take_profit: [{ price: 245 }], size: 3 })
    assert.equal(idea.direction, 'short')
})
test('buildIdeaFromCall: explicit direction (armed zone side) overrides bias', () => {
    // 'both'-bias call, a short zone fired → direction must be short, not the bias fallback
    const idea = buildIdeaFromCall(readyCall({ bias: 'both' }), { stop: 250, take_profit: [{ price: 245 }], size: 3 }, 'short')
    assert.equal(idea.direction, 'short')
})

// ── buildPositionState ─────────────────────────────────────────────────────
test('buildPositionState: seeds entry/stop/targets from the proposal', () => {
    const proposal = { entry: 248.3, stop: 245.2, stop_ref: 'rl1', take_profit: [{ price: 252, ref: 'rl2' }, { price: 256 }], size: 220 }
    const ps = buildPositionState(readyCall(), proposal, 'long', 'idea1')
    assert.equal(ps.linked_idea_id, 'idea1')
    assert.equal(ps.entry.fill_price, null)          // filled at promotion
    assert.equal(ps.entry.intended, 248.3)
    assert.equal(ps.entry.direction, 'long')
    assert.equal(ps.stop.initial, 245.2)
    assert.equal(ps.stop.current, 245.2)
    assert.equal(ps.targets.length, 2)               // full ladder retained (native TP = final only)
    assert.deepEqual(ps.targets[0], { id: 'tg1', price: 252, ref: 'rl2', size_pct: null, hit_at: null })
    assert.equal(ps.phase, 'running')
    assert.equal(ps.outcome, null)
    assert.deepEqual(ps.taken, [])
})

// ── applyEditPatch ─────────────────────────────────────────────────────────
test('applyEditPatch: re-maps + re-queues to waiting, normalizes new zones', () => {
    const set = applyEditPatch({ changes: {
        valid_until: '2026-07-10T20:00:00Z',
        entry_zones: [{ side: 'long', anchor: 250, lower: 249.5, upper: 250.5 }],
    } }, 'long')
    assert.equal(set.status, 'waiting')
    assert.equal(set['monitor_state.next_check_at'], null)
    assert.equal(set['monitor_state.armed_zone_id'], null)
    assert.equal(set.valid_until, '2026-07-10T20:00:00Z')
    assert.equal(set.entry_zones[0].id, 'ez1')          // normalized (id assigned)
    assert.equal(set.entry_zones[0].side, 'long')
})
test('applyEditPatch: empty changes just re-queues', () => {
    const set = applyEditPatch({ changes: {} })
    assert.equal(set.status, 'waiting')
    assert.equal(set.entry_zones, undefined)
})

// ── confirmCall ────────────────────────────────────────────────────────────
test('confirm: paper → saveIdea + placeOrders, call marked confirmed + linked + owned + seeded', async () => {
    const db = fakeDb(readyCall())
    let placed = 0, notified = 0, owned = null
    const deps = baseDeps(db, {
        placeOrdersForIdea: async () => { placed++ },
        notifyManualEntry:  async () => { notified++ },
        markIdeaOwned:      async (id) => { owned = id },
    })
    const res = await confirmCall('call_TSLA_x', 'u1', false, deps)
    assert.deepEqual(res, { ok: true, mode: 'paper', ideaId: 'idea1' })
    assert.equal(placed, 1)
    assert.equal(notified, 0)
    assert.equal(owned, 'idea1')                         // idea flagged Hermes-owned (Minos stands down)
    assert.equal(db.updates[0].status, 'confirmed')
    assert.equal(db.updates[0].linked_idea_id, 'idea1')
    assert.equal(db.updates[0].position_state.linked_idea_id, 'idea1')   // position_state seeded
    assert.equal(db.updates[0].position_state.stop.initial, 245.2)
})

test('confirm: manual → notifyManualEntry, no order placement', async () => {
    const db = fakeDb(readyCall({ broker: 'manual', accounts: ['manual-u1'], main_account_id: 'manual-u1' }))
    let placed = 0, notifiedLegs = null
    const deps = baseDeps(db, {
        placeOrdersForIdea: async () => { placed++ },
        notifyManualEntry:  async (_u, opts) => { notifiedLegs = opts.legs },
    })
    const res = await confirmCall('call_TSLA_x', 'u1', false, deps)
    assert.equal(res.mode, 'manual')
    assert.equal(placed, 0)
    assert.deepEqual(notifiedLegs, [{ ideaId: 'idea1', asset: 'TSLA' }])
    assert.equal(db.updates[0].status, 'confirmed')
})

test('confirm: not ready → not_ready (no idea created)', async () => {
    const db = fakeDb(readyCall({ status: 'watching' }))
    let saved = 0
    const res = await confirmCall('call_TSLA_x', 'u1', false, baseDeps(db, { saveIdea: async () => { saved++; return { ok: true, idea: {} } } }))
    assert.deepEqual(res, { ok: false, reason: 'not_ready' })
    assert.equal(saved, 0)
})

test('confirm: no proposal → no_proposal', async () => {
    const db = fakeDb(readyCall({ monitor_state: { last_assessment: { verdict: 'enter' } } }))
    const res = await confirmCall('call_TSLA_x', 'u1', false, baseDeps(db))
    assert.deepEqual(res, { ok: false, reason: 'no_proposal' })
})

test('confirm: not owner → forbidden', async () => {
    const db = fakeDb(readyCall({ user_id: 'someone_else' }))
    const res = await confirmCall('call_TSLA_x', 'u1', false, baseDeps(db))
    assert.deepEqual(res, { ok: false, reason: 'forbidden' })
})

test('confirm: placement throws → placement_failed (call NOT marked confirmed)', async () => {
    const db = fakeDb(readyCall())
    const deps = baseDeps(db, { placeOrdersForIdea: async () => { throw new Error('broker down') } })
    const res = await confirmCall('call_TSLA_x', 'u1', false, deps)
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'placement_failed')
    assert.equal(db.updates.length, 0)   // no 'confirmed' write
})

// ── editCall ───────────────────────────────────────────────────────────────
test('edit: expiring + edit_proposal → applies patch', async () => {
    const call = readyCall({ status: 'expiring', monitor_state: { last_assessment: { verdict: 'edit', edit_proposal: { why: 'roll', changes: { valid_until: '2026-07-10T20:00:00Z' } } } } })
    const db = fakeDb(call)
    const res = await editCall('call_TSLA_x', 'u1', false, baseDeps(db))
    assert.equal(res.ok, true)
    assert.equal(db.updates[0].status, 'waiting')
    assert.equal(db.updates[0].valid_until, '2026-07-10T20:00:00Z')
})
test('edit: not expiring → not_editable', async () => {
    const res = await editCall('call_TSLA_x', 'u1', false, baseDeps(fakeDb(readyCall())))
    assert.deepEqual(res, { ok: false, reason: 'not_editable' })
})

// ── dismissCall ────────────────────────────────────────────────────────────
test('dismiss: marks the call dismissed', async () => {
    const db = fakeDb(readyCall())
    const res = await dismissCall('call_TSLA_x', 'u1', false, baseDeps(db))
    assert.equal(res.ok, true)
    assert.equal(db.updates[0].status, 'dismissed')
})
test('dismiss: in_position clears the management card, does NOT terminate', async () => {
    const db = fakeDb(inPosCall())
    const res = await dismissCall('call_TSLA_x', 'u1', false, baseDeps(db))
    assert.deepEqual(res, { ok: true, dismissed: 'card' })
    assert.equal(db.updates[0]['position_state.pending_action'], null)
    assert.equal(db.updates[0].status, undefined)   // position kept
})

// ── manageCall (Phase 5 slice 3 — the hands) ─────────────────────────────────
function inPosCall(psExtra = {}, extra = {}) {
    return {
        id: 'call_TSLA_x', user_id: 'u1', asset: 'TSLA', broker: 'paper',
        main_account_id: 'p1', status: 'in_position', linked_idea_id: 'idea1', reference_levels: [],
        position_state: {
            entry: { fill_price: 248, intended: 248, direction: 'long', size: 100 },
            stop:  { current: 245, initial: 245, ref: 'rl1' },
            targets: [], taken: [],
            pending_action: { verdict: 'move_stop', severity: 3, proposal: { new_stop: 248, ref: 'rl2' } },
            ...psExtra,
        },
        ...extra,
    }
}
function ideaDoc(over = {}) {
    return {
        id: 'idea1', userId: 'u1', direction: 'long', quantity: 100,
        brokerOrders: [{ broker: 'paper', accountId: 'p1', positionId: 'pos1', quantity: 100 }],
        exitOrders: [
            { leg: 'stop', status: 'working', orderId: 'so1', accountId: 'p1', broker: 'paper', price: 245 },
            { leg: 'tp',   status: 'working', orderId: 'to1', accountId: 'p1', broker: 'paper', price: 252 },
        ],
        ...over,
    }
}
// Records the FULL update ({$set,$push}) unlike the readiness fakeDb (which keeps only $set).
function mgmtDb(call) {
    const updates = []
    return { updates, collection: () => ({ findOne: async () => call, updateOne: async (_q, u) => { updates.push(u) } }) }
}
function mDeps(db, over = {}) {
    return {
        getDb: async () => db,
        getIdea: async () => ideaDoc(),
        findOpenPosition: async () => ({ volume: 100 }),
        closePosition: async () => {},
        amendOrder: async () => {},
        cancelOrder: async () => {},
        notifyManage: async () => {},
        syncIdeaExit: async () => {},
        ...over,
    }
}

test('manage: pure helpers (link / partialQty / workingExit)', () => {
    assert.deepEqual(_resolveMainLink(ideaDoc(), inPosCall()), { broker: 'paper', accountId: 'p1', positionId: 'pos1', quantity: 100 })
    assert.equal(_partialQty(100, 50), 50)
    assert.equal(_partialQty(100, 150), 100)   // capped at remaining
    assert.equal(_partialQty(0, 50), 0)
    assert.equal(_workingExit(ideaDoc(), 'p1', 'stop').orderId, 'so1')
    assert.equal(_workingExit(ideaDoc({ exitOrders: [] }), 'p1', 'stop'), null)
})

test('manage: move_stop accept → amends the native stop, clears card, updates stop.current/phase', async () => {
    const db = mgmtDb(inPosCall())
    let amended = null, synced = null
    const res = await manageCall('call_TSLA_x', 'u1', 'move_stop', false, mDeps(db, {
        amendOrder:   async (_b, _u, _a, orderId, fields) => { amended = { orderId, fields }; return { orderId: 'so2' } },
        syncIdeaExit: async (_id, _acct, leg, patch) => { synced = { leg, patch } },
    }))
    assert.equal(res.ok, true)
    assert.deepEqual(amended, { orderId: 'so1', fields: { stopPrice: 248 } })
    assert.deepEqual(synced, { leg: 'stop', patch: { price: 248, orderId: 'so2' } })   // tracked exit kept in sync
    const u = db.updates[0]
    assert.equal(u.$set['position_state.pending_action'], null)
    assert.equal(u.$set['position_state.stop.current'], 248)
    assert.equal(u.$set['position_state.phase'], 'breakeven')          // new_stop 248 == entry 248
    assert.ok(u.$push['monitor_state.timeline'])                       // journal continued
})

test('manage: take_partial → sized closePosition + taken ledger push', async () => {
    const db = mgmtDb(inPosCall({ pending_action: { verdict: 'take_partial', severity: 2, proposal: { size_pct: 50 } } }))
    let closed = null
    const res = await manageCall('call_TSLA_x', 'u1', 'take_partial', false, mDeps(db, { closePosition: async (_b, _u, _a, _p, opts) => { closed = opts } }))
    assert.equal(res.ok, true)
    assert.deepEqual(closed, { quantity: 50 })                         // 50% of live 100
    assert.equal(db.updates[0].$push['position_state.taken'].size, 50)
})

test('manage: exit_now works bare (no pending) → full close', async () => {
    const db = mgmtDb(inPosCall({ pending_action: null }))
    let called = false, opts = 'x'
    const res = await manageCall('call_TSLA_x', 'u1', 'exit_now', false, mDeps(db, { closePosition: async (_b, _u, _a, _p, o) => { called = true; opts = o } }))
    assert.equal(res.ok, true)
    assert.equal(called, true)
    assert.equal(opts, undefined)                                      // full close: no quantity
})

test('manage: already flat → clears card, NO execution (Hermes reconciles the close)', async () => {
    const db = mgmtDb(inPosCall())
    let amended = 0
    const res = await manageCall('call_TSLA_x', 'u1', 'move_stop', false, mDeps(db, { findOpenPosition: async () => null, amendOrder: async () => { amended++ } }))
    assert.deepEqual(res, { ok: true, alreadyFlat: true })
    assert.equal(amended, 0)
    assert.equal(db.updates[0].$set['position_state.pending_action'], null)
})

test('manage: not in_position → not_in_position', async () => {
    const res = await manageCall('call_TSLA_x', 'u1', 'move_stop', false, mDeps(mgmtDb(inPosCall({}, { status: 'ready' }))))
    assert.deepEqual(res, { ok: false, reason: 'not_in_position' })
})

test('manage: verb without matching pending (non-exit) → no_pending_action', async () => {
    const res = await manageCall('call_TSLA_x', 'u1', 'take_partial', false, mDeps(mgmtDb(inPosCall())))
    assert.deepEqual(res, { ok: false, reason: 'no_pending_action' })
})

test('manage: manual mode → notifies instruction, no broker execution, records intent', async () => {
    const db = mgmtDb(inPosCall({}, { broker: 'manual', main_account_id: 'manual-u1' }))
    let notified = null, closed = 0
    const res = await manageCall('call_TSLA_x', 'u1', 'move_stop', false, mDeps(db, { notifyManage: async (_c, card) => { notified = card }, closePosition: async () => { closed++ } }))
    assert.equal(res.manual, true)
    assert.equal(notified.verdict, 'move_stop')
    assert.equal(closed, 0)
    assert.equal(db.updates[0].$set['position_state.stop.current'], 248)
})

test('manage: bad verb → bad_action', async () => {
    const res = await manageCall('call_TSLA_x', 'u1', 'frobnicate', false, mDeps(mgmtDb(inPosCall())))
    assert.deepEqual(res, { ok: false, reason: 'bad_action' })
})
