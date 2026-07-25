import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    deriveMode, buildIdeaFromCall, buildPositionState, applyEditPatch, confirmCall, editCall, dismissCall,
    manageCall, _resolveMainLink, _resolveAllLinks, _workingExit, _partialQty,
    reviveCall, declineReentry, _reentryValidUntil,
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

// Fake db: findOne returns the current (merged) call — updateOne folds each $set into it, so a
// re-read after the merge sees the stamped execution fields (P3b self-shadow). updates[] records
// every $set patch in order.
function fakeDb(call) {
    const updates = []
    let cur = { ...call }
    return { updates, collection: () => ({
        findOne:   async () => cur,
        updateOne: async (_q, u) => { updates.push(u.$set); cur = { ...cur, ...u.$set } },
    }) }
}

function baseDeps(db, over = {}) {
    return {
        getDb:              async () => db,
        // Enrichment engine returns ONE child carrying the execution shape (kind:'idea' is stripped
        // on merge; the call keeps kind:'call'). status:'hit' converges onto the call.
        buildIdeaChildren:  async () => ({ ok: true, children: [{
            id: 'idea1', kind: 'idea', parentId: null, status: 'hit',
            pendingOrder: { plan: [{ broker: 'paper', accountId: 'p1', quantity: 220, type: 'market' }] },
        }] }),
        placeOrdersForIdea: async () => ({ ok: true }),
        notifyManualEntry:  async () => ({}),
        entryLegFromIdea:   (idea) => ({ ideaId: idea.id, asset: 'TSLA' }),
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
    assert.equal(idea.callId, 'call_TSLA_x')   // origin back-reference → survives onto the trade
})
test('buildIdeaFromCall: stamps callId even when the call id is the only linkage', () => {
    const idea = buildIdeaFromCall(readyCall({ id: 'call_abc' }), { stop: 1, take_profit: [{ price: 2 }], size: 1 })
    assert.equal(idea.callId, 'call_abc')
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
test('confirm: paper → merges execution onto the call (self-shadow), places, seeds position_state', async () => {
    const db = fakeDb(readyCall())
    let placed = 0, notified = 0
    const deps = baseDeps(db, {
        placeOrdersForIdea: async () => { placed++ },
        notifyManualEntry:  async () => { notified++ },
    })
    const res = await confirmCall('call_TSLA_x', 'u1', false, deps)
    assert.deepEqual(res, { ok: true, mode: 'paper', ideaId: 'call_TSLA_x' })   // self, not a shadow id
    assert.equal(placed, 1)
    assert.equal(notified, 0)
    const set = db.updates[0]
    assert.equal(set.status, 'hit')                                  // converged execution vocab
    assert.equal(set.ownedBy, undefined)                             // kind:'call' IS ownership (no flag)
    assert.equal(set.callId, 'call_TSLA_x')                          // self-origin → tradeCapture origin='call'
    assert.equal(set.linked_idea_id, 'call_TSLA_x')                  // self-link
    assert.equal(set.position_state.linked_idea_id, 'call_TSLA_x')   // position_state seeded onto the call
    assert.equal(set.position_state.stop.initial, 245.2)
    assert.deepEqual(set.pendingOrder.plan[0].accountId, 'p1')       // execution shape merged in
})

test('confirm: manual → notifyManualEntry with the merged call leg, no order placement', async () => {
    const db = fakeDb(readyCall({ broker: 'manual', accounts: ['manual-u1'], main_account_id: 'manual-u1' }))
    let placed = 0, notifiedLegs = null
    const deps = baseDeps(db, {
        placeOrdersForIdea: async () => { placed++ },
        notifyManualEntry:  async (_u, opts) => { notifiedLegs = opts.legs },
    })
    const res = await confirmCall('call_TSLA_x', 'u1', false, deps)
    assert.equal(res.mode, 'manual')
    assert.equal(placed, 0)
    assert.deepEqual(notifiedLegs, [{ ideaId: 'call_TSLA_x', asset: 'TSLA' }])   // leg built from the call itself
    assert.equal(db.updates[0].status, 'hit')
})

test('confirm: not ready → not_ready (no enrichment)', async () => {
    const db = fakeDb(readyCall({ status: 'watching' }))
    let built = 0
    const res = await confirmCall('call_TSLA_x', 'u1', false, baseDeps(db, { buildIdeaChildren: async () => { built++; return { ok: true, children: [{}] } } }))
    assert.deepEqual(res, { ok: false, reason: 'not_ready' })
    assert.equal(built, 0)
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

test('confirm: placement throws → placement_failed, call rolled back to ready (retryable)', async () => {
    const db = fakeDb(readyCall())
    const deps = baseDeps(db, { placeOrdersForIdea: async () => { throw new Error('broker down') } })
    const res = await confirmCall('call_TSLA_x', 'u1', false, deps)
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'placement_failed')
    // merge write happened, then a compensating reset — the call is not left stuck 'hit'.
    assert.equal(db.updates.at(-1).status, 'ready')
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

// ── manageCall multi-account fan-out ─────────────────────────────────────────
// A call placed on >1 account has one position per account; management must reach every one.
function ideaDoc2(over = {}) {
    return {
        id: 'idea1', userId: 'u1', direction: 'long', quantity: 160,
        brokerOrders: [
            { broker: 'paper', accountId: 'p1', positionId: 'pos1', quantity: 100 },
            { broker: 'paper', accountId: 'p2', positionId: 'pos2', quantity: 60 },
        ],
        exitOrders: [
            { leg: 'stop', status: 'working', orderId: 'so1', accountId: 'p1', broker: 'paper', price: 245 },
            { leg: 'tp',   status: 'working', orderId: 'to1', accountId: 'p1', broker: 'paper', price: 252 },
            { leg: 'stop', status: 'working', orderId: 'so2', accountId: 'p2', broker: 'paper', price: 245 },
            { leg: 'tp',   status: 'working', orderId: 'to2', accountId: 'p2', broker: 'paper', price: 252 },
        ],
        ...over,
    }
}
const inPosCall2 = (psExtra = {}, extra = {}) => inPosCall(psExtra, { accounts: ['p1', 'p2'], ...extra })

test('manage: _resolveAllLinks → one link per account (scoped to call.accounts)', () => {
    assert.deepEqual(_resolveAllLinks(ideaDoc2(), inPosCall2()), [
        { broker: 'paper', accountId: 'p1', positionId: 'pos1', quantity: 100 },
        { broker: 'paper', accountId: 'p2', positionId: 'pos2', quantity: 60 },
    ])
    // no accounts on the call → all links (never manage NONE while positions are open)
    assert.equal(_resolveAllLinks(ideaDoc2(), inPosCall()).length, 2)
})

test('manage: move_stop fans out → amends BOTH accounts native stops', async () => {
    const db = mgmtDb(inPosCall2())
    const amended = []
    const res = await manageCall('call_TSLA_x', 'u1', 'move_stop', false, mDeps(db, {
        getIdea:      async () => ideaDoc2(),
        amendOrder:   async (_b, _u, acct, orderId, fields) => { amended.push({ acct, orderId, fields }); return { orderId: orderId + 'x' } },
        syncIdeaExit: async () => {},
    }))
    assert.equal(res.ok, true)
    assert.deepEqual(res.accounts, [{ accountId: 'p1', ok: true }, { accountId: 'p2', ok: true }])
    assert.deepEqual(amended, [
        { acct: 'p1', orderId: 'so1', fields: { stopPrice: 248 } },
        { acct: 'p2', orderId: 'so2', fields: { stopPrice: 248 } },
    ])
    assert.equal(db.updates[0].$set['position_state.stop.current'], 248)
})

test('manage: take_partial fans out → per-account size summed into taken ledger', async () => {
    const db = mgmtDb(inPosCall2({ pending_action: { verdict: 'take_partial', severity: 2, proposal: { size_pct: 50 } } }))
    const closed = []
    const res = await manageCall('call_TSLA_x', 'u1', 'take_partial', false, mDeps(db, {
        getIdea:          async () => ideaDoc2(),
        findOpenPosition: async (_b, _u, acct) => ({ volume: acct === 'p2' ? 60 : 100 }),
        closePosition:    async (_b, _u, acct, _p, opts) => { closed.push({ acct, ...opts }) },
    }))
    assert.equal(res.ok, true)
    assert.deepEqual(closed, [{ acct: 'p1', quantity: 50 }, { acct: 'p2', quantity: 30 }])
    assert.equal(db.updates[0].$push['position_state.taken'].size, 80)   // 50 + 30 across accounts
})

test('manage: one account already flat, one open → applies to the open one only, still ok', async () => {
    const db = mgmtDb(inPosCall2())
    const amended = []
    const res = await manageCall('call_TSLA_x', 'u1', 'move_stop', false, mDeps(db, {
        getIdea:          async () => ideaDoc2(),
        findOpenPosition: async (_b, _u, acct) => (acct === 'p1' ? null : { volume: 60 }),
        amendOrder:       async (_b, _u, acct, orderId) => { amended.push(acct); return { orderId } },
        syncIdeaExit:     async () => {},
    }))
    assert.equal(res.ok, true)
    assert.deepEqual(res.accounts, [{ accountId: 'p1', alreadyFlat: true }, { accountId: 'p2', ok: true }])
    assert.deepEqual(amended, ['p2'])
    assert.equal(db.updates[0].$set['position_state.stop.current'], 248)   // aggregate still persisted
})

test('manage: all accounts unreachable → broker_unreachable, no persist', async () => {
    const db = mgmtDb(inPosCall2())
    const res = await manageCall('call_TSLA_x', 'u1', 'move_stop', false, mDeps(db, {
        getIdea:          async () => ideaDoc2(),
        findOpenPosition: async () => { throw new Error('down') },
    }))
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'broker_unreachable')
    assert.equal(db.updates.length, 0)
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

// ── P2: re-entry after a stop-out ──────────────────────────────────────────
function closedReentryCall(extra = {}) {
    return {
        id: 'call_TSLA_x', user_id: 'u1', asset: 'TSLA', trade_type: 'day', bias: 'long',
        status: 'closed', reentry_count: 0, linked_idea_id: 'idea1',
        position_state: { reentry: { offered: true, why: 'trend intact' }, outcome: { reason: 'stop' } },
        monitor_state: { pulse_anchor_px: 250, last_pulse_at: '2026-07-16T10:00:00Z' },
        ...extra,
    }
}

test('_reentryValidUntil: horizon by trade_type', () => {
    const T = Date.parse('2026-07-16T00:00:00Z')
    assert.equal(_reentryValidUntil({ trade_type: 'intraday' }, T), new Date(T + 1  * 864e5).toISOString())
    assert.equal(_reentryValidUntil({ trade_type: 'day' },      T), new Date(T + 3  * 864e5).toISOString())
    assert.equal(_reentryValidUntil({ trade_type: 'swing' },    T), new Date(T + 14 * 864e5).toISOString())
})

test('reviveCall: closed + offered → revives to waiting, clears position, re-seeds, bumps count', async () => {
    const db  = fakeDb(closedReentryCall())
    const res = await reviveCall('call_TSLA_x', 'u1', false, baseDeps(db))
    assert.equal(res.ok, true)
    assert.equal(res.reentry_count, 1)
    const set = db.updates[0]
    assert.equal(set.status, 'waiting')
    assert.equal(set.position_state, null)
    assert.equal(set.linked_idea_id, null)
    assert.equal(set['monitor_state.armed_zone_id'], null)
    assert.equal(set['monitor_state.pulse_anchor_px'], null)     // re-seed the pulse anchor
    assert.equal(set['monitor_state.next_check_at'], null)       // due next tick
    assert.ok(typeof set.valid_until === 'string' && set.valid_until > new Date().toISOString())
})
test('reviveCall: not closed → not_closed', async () => {
    const res = await reviveCall('call_TSLA_x', 'u1', false, baseDeps(fakeDb(closedReentryCall({ status: 'waiting' }))))
    assert.deepEqual(res, { ok: false, reason: 'not_closed' })
})
test('reviveCall: no offer → no_reentry_offer', async () => {
    const res = await reviveCall('call_TSLA_x', 'u1', false, baseDeps(fakeDb(closedReentryCall({ position_state: { reentry: { offered: false } } }))))
    assert.deepEqual(res, { ok: false, reason: 'no_reentry_offer' })
})
test('reviveCall: other user → forbidden', async () => {
    const res = await reviveCall('call_TSLA_x', 'u2', false, baseDeps(fakeDb(closedReentryCall())))
    assert.deepEqual(res, { ok: false, reason: 'forbidden' })
})
test('declineReentry: closed → clears offer + stamps declined_at, status stays closed', async () => {
    const db  = fakeDb(closedReentryCall())
    const res = await declineReentry('call_TSLA_x', 'u1', false, baseDeps(db))
    assert.equal(res.ok, true)
    assert.equal(db.updates[0]['position_state.reentry.offered'], false)
    assert.ok(db.updates[0]['position_state.reentry.declined_at'])
    assert.equal(db.updates[0].status, undefined)               // NOT flipped to 'dismissed'
})
