import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    deriveMode, buildIdeaFromCall, applyEditPatch, confirmCall, editCall, dismissCall,
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
test('buildIdeaFromCall: maps proposal → immediate market idea', () => {
    const idea = buildIdeaFromCall(readyCall(), readyCall().monitor_state.last_assessment.proposal)
    assert.equal(idea.asset, 'TSLA')
    assert.equal(idea.direction, 'long')
    assert.equal(idea.quantity, 220)
    assert.equal(idea.immediate, true)
    assert.equal(idea.stop_loss, '245.2')
    assert.equal(idea.take_profit, '252')
    assert.deepEqual(idea.accounts, ['paper-u1'])
    assert.equal(idea.mainAccountId, 'paper-u1')
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
test('confirm: paper → saveIdea + placeOrders, call marked confirmed + linked', async () => {
    const db = fakeDb(readyCall())
    let placed = 0, notified = 0
    const deps = baseDeps(db, { placeOrdersForIdea: async () => { placed++ }, notifyManualEntry: async () => { notified++ } })
    const res = await confirmCall('call_TSLA_x', 'u1', false, deps)
    assert.deepEqual(res, { ok: true, mode: 'paper', ideaId: 'idea1' })
    assert.equal(placed, 1)
    assert.equal(notified, 0)
    assert.equal(db.updates[0].status, 'confirmed')
    assert.equal(db.updates[0].linked_idea_id, 'idea1')
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
