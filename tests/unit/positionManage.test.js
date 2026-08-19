import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyManage } from '../../services/positionManage.service.js'

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
            getDb: async () => ({ collection: () => ({ updateOne: async () => {} }) }),
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
