import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyManage, manageApplied } from '../../services/positionManage.service.js'

// THE HANDS of in-position management, and until now it had no direct test — only the coverage it
// picked up through talosHandoff. That is exactly the gap this file exists to close, because the
// thing being asserted here is what a SECOND desk inherits when it wires in.
//
// A self-executed venue (manual: real money at an institution the app cannot reach) has no broker to
// call. Talos knew that and branched before calling in, so the executor itself never had to. Reached
// without that branch it called closePosition anyway, the adapter threw its guard message, and the
// user was told `execution_failed` — a broker failure that never happened.

/** Every broker dep, each one recording that it was reached. Reaching ANY of them is the bug. */
function spyDeps(over = {}) {
    const called = []
    const spy = (name, ret) => async (...args) => { called.push({ name, args }); return ret }
    return {
        called,
        deps: {
            getDb: async () => ({ collection: (name) => name === 'journal' ? { insertOne: async () => {} } : { updateOne: async () => {} } }),
            deferIfClosed:    spy('deferIfClosed', { deferred: false }),
            findOpenPosition: spy('findOpenPosition', { volume: 100 }),
            closePosition:    spy('closePosition'),
            amendOrder:       spy('amendOrder', {}),
            cancelOrder:      spy('cancelOrder'),
            syncExit:         spy('syncExit'),
            ...over,
        },
    }
}

const LINKED = {
    id: 'e1', userId: 'u1', asset: 'NVDA', kind: 'setup', accounts: ['a1'],
    brokerOrders: [{ broker: 'ctrader', accountId: 'a1', positionId: 'pos1', quantity: 100 }],
    exitOrders: [{ leg: 'stop', status: 'working', orderId: 'so1', accountId: 'a1', price: 112 }],
    position_state: { entry: { fill_price: 118, direction: 'long' }, stop: { current: 112 } },
}

// ── The self-executed short-circuit ───────────────────────────────────────────

test('a self-executed venue is answered without touching a broker', async () => {
    const { called, deps } = spyDeps()
    const res = await applyManage({
        entity: { ...LINKED, broker: 'manual' }, holder: { ...LINKED, broker: 'manual' },
        verb: 'exit_now', proposal: {}, userId: 'u1', deps,
    })

    assert.deepEqual(res, { ok: true, selfExecuted: true, verb: 'exit_now' })
    assert.deepEqual(called.map(c => c.name), [], 'no broker dep may be reached for a manual venue')
})

test('the hours gate is not asked either — an instruction to a human is not an order', async () => {
    // The ordering claim, asserted rather than left in a comment. Today a manual manage posts its
    // card immediately; routing it through deferIfClosed would queue it to the open instead, which
    // is a real behaviour change and not one this made.
    const { called, deps } = spyDeps()
    await applyManage({
        entity: { ...LINKED, broker: 'manual' }, holder: { ...LINKED, broker: 'manual' },
        verb: 'move_stop', proposal: { new_stop: 118 }, userId: 'u1', deps,
    })
    assert.equal(called.some(c => c.name === 'deferIfClosed'), false)
})

test('a self-executed venue with NO broker linkage is still answered, not refused', async () => {
    // The reason the check sits above the links guard. A venue that places nothing may have recorded
    // nothing, and `no_position_link` would refuse the one venue whose positions never produce one.
    const { deps } = spyDeps()
    const bare = { ...LINKED, broker: 'manual', brokerOrders: [], exitOrders: [] }
    const res  = await applyManage({ entity: bare, holder: bare, verb: 'exit_now', proposal: {}, userId: 'u1', deps })
    assert.equal(res.selfExecuted, true)
})

test('it writes nothing — recording the intent stays the desk\'s, in the desk\'s order', async () => {
    // notify-then-write is the desk's sequence: an instruction only a human can carry out must not
    // be written down as applied if the human was never told. A write here would invert that.
    let wrote = false
    const { deps } = spyDeps({ getDb: async () => ({ collection: () => ({ updateOne: async () => { wrote = true } }) }) })
    await applyManage({
        entity: { ...LINKED, broker: 'manual' }, holder: { ...LINKED, broker: 'manual' },
        verb: 'exit_now', proposal: {}, userId: 'u1', deps,
    })
    assert.equal(wrote, false)
})

// ── Everything else is untouched ──────────────────────────────────────────────

test('a real broker still goes the whole way through', async () => {
    const { called, deps } = spyDeps()
    const res = await applyManage({
        entity: { ...LINKED, broker: 'ctrader' }, holder: { ...LINKED, broker: 'ctrader' },
        verb: 'exit_now', proposal: {}, userId: 'u1', deps,
    })

    assert.equal(res.ok, true)
    assert.equal(res.selfExecuted, undefined)
    assert.equal(called.some(c => c.name === 'deferIfClosed'), true)
    assert.equal(called.some(c => c.name === 'closePosition'), true)
})

test('an unknown or absent venue is treated as one the app executes at, not skipped', async () => {
    // The safe direction for a legacy document: fall through and fail visibly at the broker call,
    // rather than silently answer "the user will handle it" and leave a live position unmanaged.
    const { called, deps } = spyDeps()
    const res = await applyManage({
        entity: { ...LINKED, broker: null }, holder: { ...LINKED, broker: null },
        verb: 'exit_now', proposal: {}, userId: 'u1', deps,
    })
    assert.equal(res.selfExecuted, undefined)
    assert.equal(called.some(c => c.name === 'closePosition'), true)
})

test('no linkage at a real venue is still the refusal it always was', async () => {
    const { deps } = spyDeps()
    const bare = { ...LINKED, broker: 'ctrader', brokerOrders: [] }
    const res  = await applyManage({ entity: bare, holder: bare, verb: 'exit_now', proposal: {}, userId: 'u1', deps })
    assert.deepEqual(res, { ok: false, reason: 'no_position_link' })
})

// ── The basis boundary ────────────────────────────────────────────────────────
// An aliased index CFD (cTrader's US100 for NQ) is priced one futures basis away from the level the
// user authored; the holder carries that offset from the fork (`basisOffset`). The ORDER must carry
// the shifted level and the RECORD the authored one — exactly what buildExitOrder does for a
// placement. move_stop / let_run went to amendOrder with the raw level.

const BASIS = { ...LINKED, basisOffset: -227.5 }

test('move_stop amends at the SHIFTED level and records the AUTHORED one', async () => {
    const { called, deps } = spyDeps()
    const r = await applyManage({ entity: BASIS, holder: BASIS, verb: 'move_stop', proposal: { new_stop: 20000 }, userId: 'u1', deps })
    assert.equal(r.ok, true)
    const amend = called.find(c => c.name === 'amendOrder')
    assert.deepEqual(amend.args[4], { stopPrice: 19772.5 }, 'broker sees 20000 + (−227.5)')
    const sync = called.find(c => c.name === 'syncExit')
    assert.equal(sync.args[3].price, 20000, 'our record keeps the authored level')
})

test('let_run with a new target shifts the limit the same way', async () => {
    const holder = { ...BASIS, exitOrders: [{ leg: 'tp', status: 'working', orderId: 'to1', accountId: 'a1', price: 20500 }] }
    const { called, deps } = spyDeps()
    await applyManage({ entity: holder, holder, verb: 'let_run', proposal: { new_tp: 21000 }, userId: 'u1', deps })
    assert.deepEqual(called.find(c => c.name === 'amendOrder').args[4], { limitPrice: 20772.5 })
})

test('no basisOffset (every non-index instrument) is the identity — nothing changes for them', async () => {
    const { called, deps } = spyDeps()
    await applyManage({ entity: LINKED, holder: LINKED, verb: 'move_stop', proposal: { new_stop: 115 }, userId: 'u1', deps })
    assert.deepEqual(called.find(c => c.name === 'amendOrder').args[4], { stopPrice: 115 })
})

// ── What gets written down ────────────────────────────────────────────────────

test('manageApplied writes the position change to the entity and the line to the JOURNAL', () => {
    const ps = { entry: { fill_price: 118, direction: 'long' }, stop: { current: 112 } }
    const { update, journal } = manageApplied('move_stop', { new_stop: 118, ref: 'entry' }, ps, {}, Date.UTC(2026, 8, 19, 10))
    assert.equal(update.$set['position_state.stop.current'], 118)
    assert.equal(update.$set['position_state.phase'], 'breakeven')
    assert.equal(update.$set['position_state.pending_action'], null)
    assert.equal(update.$push, undefined, 'a stop move pushes nothing onto the entity')
    // The journal row, not a monitor_state.timeline line — nothing reads that array any more.
    assert.equal(journal.reason, 'manage')
    assert.equal(journal.verdict, 'move_stop')
    assert.equal(journal.at, '2026-09-19T10:00:00.000Z')
    assert.match(journal.note, /Moved my stop to 118 — locking in breakeven/)
})

test('on a manual venue the row says the user was ASKED — nothing has happened at the broker yet', () => {
    const ps = { entry: { fill_price: 118, direction: 'long' }, stop: { current: 112 } }
    const { journal } = manageApplied('move_stop', { new_stop: 118 }, ps, { manual: true }, 1)
    assert.match(journal.note, /^Asked you to move the stop to 118 at your institution/)
    assert.doesNotMatch(journal.note, /^Moved/)
    assert.match(manageApplied('exit_now', {}, ps, { manual: true }, 1).journal.note, /^Asked you to flatten/)
})

test('a fan-out that applied on some accounts and failed on others names the failures', () => {
    const ps = { entry: { fill_price: 118, direction: 'long' }, stop: { current: 112 } }
    const { journal } = manageApplied('move_stop', { new_stop: 115 }, ps, { failed: ['a2'] }, 1)
    assert.match(journal.note, /Moved my stop to 115 — tightening protection\. Not on account a2 — that broker call failed/)
    assert.doesNotMatch(manageApplied('move_stop', { new_stop: 115 }, ps, { failed: [] }, 1).journal.note, /Not on/)
})

test('a partial pushes the taken ledger, and only that', () => {
    const ps = { entry: { fill_price: 118, direction: 'long' }, stop: { current: 112 } }
    const { update, journal } = manageApplied('take_partial', { size_pct: 50 }, ps, { qty: 50 }, Date.UTC(2026, 8, 19, 10))
    assert.deepEqual(Object.keys(update.$push), ['position_state.taken'])
    assert.equal(update.$push['position_state.taken'].size, 50)
    assert.match(journal.note, /Banked 50%/)
})

test('applyManage journals through the repo — one write, then the line', async () => {
    const updates = []
    const journal = []
    const { deps } = spyDeps()
    // The journal is appended by the repo's own seam over the SAME injected db as the entity
    // write — so a fake db sees both, and a unit test never opens the real connection.
    const db = { collection: (name) => name === 'journal'
        ? { insertOne: async (row) => { journal.push(row) } }
        : { updateOne: async (_q, u) => { updates.push(u); return { matchedCount: 1 } } } }
    const res = await applyManage({ entity: LINKED, holder: LINKED, verb: 'exit_now', proposal: {}, userId: 'u1', nowMs: 1, deps: { ...deps, getDb: async () => db } })
    assert.equal(res.ok, true)
    assert.equal(updates.length, 1)
    assert.equal(journal.length, 1)
    assert.equal(journal[0].entityId, 'e1')
    assert.equal(journal[0].reason, 'manage')
    assert.equal(journal[0].verdict, 'exit_now')
    assert.equal(updates[0].$push, undefined, 'and nothing on the entity itself')
})
