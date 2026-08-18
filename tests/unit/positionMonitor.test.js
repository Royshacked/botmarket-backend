import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPosition, executeDeferredClose } from '../../monitoring/positionMonitor.js'

// The SOFTWARE exit tier — the code that decides whether to send a closing order to a broker, how
// big it is, and whether to send it at all.
//
// It had no tests. It sat dormant while its only caller was deleted, and went live again the moment
// exit.monitor.js started. Every branch below is a money path: a guard that fails open re-fires a
// stop every minute, a size that comes out wrong closes more of a position than the user asked, and
// an off-hours gate that leaks sends an order into a venue that cannot fill it.
//
// These do not test the evaluators — `evaluateTree` decides IF a condition is true and has its own
// suite. They test what this module does with that answer.

const LINK  = { broker: 'ctrader', accountId: 'A1', positionId: 'P1', quantity: 10 }
const LINK2 = { broker: 'ctrader', accountId: 'A2', positionId: 'P2', quantity: 5 }

const pos = (over = {}) => ({
    id: 'e1', userId: 'u1', asset: 'SPY', asset_class: 'stock', status: 'long', direction: 'long',
    quantity: 10, broker: 'ctrader', kind: 'idea', activatedAt: 1_000,
    brokerOrders: [LINK], ...over,
})

const CANDLES = [{ o: 1, h: 2, l: 1, c: 2, t: 1 }]
const TREE    = { operator: 'OR', children: [{ condition: 'close below 400' }] }
const residualOf = (...children) => ({ operator: 'OR', children })

/**
 * Every collaborator recorded. `fires` decides which evaluations come back true — a list of
 * booleans consumed in call order, so a test can say "the stop is true, the target is not" without
 * standing up a real evaluator.
 */
function harness({ fires = [], deferred = false, closeThrows = false, orderId = 'O9' } = {}) {
    const calls = { closes: [], orders: [], patches: [], updates: [], notifies: [], gates: [], closed: [], states: [] }
    let i = 0
    const next = () => (i < fires.length ? fires[i++] : (i++, false))

    const deps = {
        evaluateTree:       async () => ({ triggered: next(), which: 'close below 400' }),
        evaluateConditions: async () => ({ triggered: next(), which: 'close below 400' }),
        buildSymbolMap:     async () => ({}),
        buildVolumeCtx:     async () => ({}),
        persistStates:      async (idea, phase, states) => { calls.states.push({ phase, states }) },
        closePosition:      async (broker, userId, accountId, positionId) => {
            calls.closes.push({ broker, userId, accountId, positionId })
            if (closeThrows) throw new Error('broker rejected')
        },
        placeOrder:         async (broker, userId, accountId, order) => {
            calls.orders.push({ broker, userId, accountId, order }); return { orderId }
        },
        patch:              async (id, fields) => { calls.patches.push({ id, fields }) },
        update:             async (id, updateDoc) => { calls.updates.push({ id, updateDoc }) },
        getById:            async () => null,
        notifyManualExit:   async (userId, payload) => { calls.notifies.push({ userId, payload }) },
        deferIfClosed:      async (req) => { calls.gates.push(req); return { deferred } },
    }
    const onClose = async (id, reason) => { calls.closed.push({ id, reason }) }
    return { deps, calls, onClose }
}

const run = (idea, h) => checkPosition(idea, CANDLES, CANDLES, CANDLES, h.onClose, h.deps)

// ── the re-fire guards ───────────────────────────────────────────────────────

for (const state of ['awaiting_manual_close', 'awaiting_market_close']) {
    test(`a close already pending (${state}) stops the whole check`, async () => {
        // The decision is made and waiting on someone. Re-evaluating would re-fire it every poll —
        // and could queue a SECOND leg, since a stop and a target both look true on a stale candle.
        const h = harness({ fires: [true, true] })
        await run(pos({ orderState: state, stop_condition_tree: TREE, tp_condition_tree: TREE }), h)
        assert.deepEqual(h.calls.closes, [])
        assert.deepEqual(h.calls.orders, [])
        assert.deepEqual(h.calls.patches, [])
    })
}

test('a leg the broker holds natively is never evaluated', async () => {
    const h = harness({ fires: [true] })
    await run(pos({ monitorStop: false, stop_condition_tree: TREE }), h)
    assert.deepEqual(h.calls.closes, [], 'the resting order owns this leg')
})

test('the STOP wins the tick — the target is not even looked at', async () => {
    // Order matters on a stale candle, where both legs can read true. The position is closed once.
    const h = harness({ fires: [true, true] })
    await run(pos({ stop_condition_tree: TREE, tp_condition_tree: TREE }), h)
    assert.equal(h.calls.closes.length, 1)
    assert.deepEqual(h.calls.states.map(s => s.phase), ['stop'], 'the tp leg never ran')
})

// ── manual: alert, never execute ─────────────────────────────────────────────

test('MANUAL alerts once and parks — no broker call, ever', async () => {
    const h = harness({ fires: [true] })
    const manual = pos({ broker: 'manual', stop_condition_tree: TREE })
    await run(manual, h)

    assert.deepEqual(h.calls.closes, [], 'a manual position has no venue to send to')
    assert.deepEqual(h.calls.orders, [])
    assert.equal(h.calls.notifies.length, 1)
    assert.equal(h.calls.notifies[0].payload.reason, 'stop')
    assert.equal(h.calls.notifies[0].payload.kind, 'idea', 'the card belongs to the entity\'s own desk')
    assert.deepEqual(h.calls.patches[0].fields, { orderState: 'awaiting_manual_close', pendingCloseReason: 'stop' })
})

test('MANUAL alerts ONCE across every slice of a tick, not once per slice', async () => {
    // Two residual slices both true in the same tick. Without the explicit same-tick guard the user
    // gets two "go close this at your broker" cards for one position.
    const h = harness({ fires: [true, true] })
    const manual = pos({
        broker: 'manual',
        stopMonitorTree: residualOf({ condition: 'a', quantity: 5 }, { condition: 'b', quantity: 5 }),
    })
    await run(manual, h)
    assert.equal(h.calls.notifies.length, 1)
    assert.equal(h.calls.patches.length, 1)
})

// ── the off-hours gate ───────────────────────────────────────────────────────

test('a shut venue queues the close and sends NOTHING', async () => {
    const h = harness({ fires: [true], deferred: true })
    await run(pos({ stop_condition_tree: TREE }), h)

    assert.deepEqual(h.calls.closes, [], 'a real broker would reject it; paper would fill at a price nobody traded')
    assert.deepEqual(h.calls.patches[0].fields, { orderState: 'awaiting_market_close', pendingCloseReason: 'stop' })
})

test('the queued row carries everything needed to replay the exact close', async () => {
    // Only ONE verdict is consumed: the stop leg has no conditions at all, so it is skipped
    // outright rather than evaluated-and-false.
    const h = harness({ fires: [true], deferred: true })
    await run(pos({ tpMonitorTree: residualOf({ condition: 'a', quantity: 4 }) }), h)

    const gate = h.calls.gates[0]
    assert.deepEqual(gate.action, { type: 'exit', reason: 'tp', quantity: 4, leg: 'tp', tag: 'tp:0' })
    assert.equal(gate.queuedBy, 'monitor', 'the list must not offer to cancel a mechanical consequence')
    assert.equal(gate.origin.entityId, 'e1')
})

test('an open venue passes the gate straight through to the broker', async () => {
    const h = harness({ fires: [true], deferred: false })
    await run(pos({ stop_condition_tree: TREE }), h)
    assert.equal(h.calls.closes.length, 1)
})

// ── closing: full, partial, and the sizes ────────────────────────────────────

test('a full close closes EVERY linked account', async () => {
    const h = harness({ fires: [true] })
    await run(pos({ stop_condition_tree: TREE, brokerOrders: [LINK, LINK2] }), h)
    assert.deepEqual(h.calls.closes.map(c => c.positionId), ['P1', 'P2'])
    assert.deepEqual(h.calls.updates[0].updateDoc.$set, { pendingCloseReason: 'stop' })
})

test('one account rejecting does not abandon the others', async () => {
    const h = harness({ fires: [true], closeThrows: true })
    await run(pos({ stop_condition_tree: TREE, brokerOrders: [LINK, LINK2] }), h)
    assert.equal(h.calls.closes.length, 2, 'the second account still gets its close')
    assert.equal(h.calls.updates.length, 1)
})

test('a partial close is scaled per account by that account\'s share of the position', async () => {
    // 15 units across two accounts (10 + 5); the slice asks for 6. Each account sends its own share,
    // or a two-account position would close 6 twice and take 12 off a 15-unit book.
    const h = harness({ fires: [true] })
    await run(pos({
        quantity: 15, brokerOrders: [LINK, LINK2],
        stopMonitorTree: residualOf({ condition: 'a', quantity: 6 }),
    }), h)
    assert.deepEqual(h.calls.orders.map(o => o.order.quantity), [4, 2])
})

test('a slice larger than what is left is clamped, never oversold', async () => {
    const h = harness({ fires: [true] })
    await run(pos({
        quantity: 10, brokerOrders: [LINK],
        stopMonitorTree: residualOf({ condition: 'a', quantity: 999 }),
    }), h)
    assert.equal(h.calls.orders.length, 1)
    assert.equal(h.calls.orders[0].order.quantity, 10, 'clamped to the position, not 999')
})

test('a partial close records the exit order and tags the slice as fired', async () => {
    const h = harness({ fires: [true] })
    await run(pos({ stopMonitorTree: residualOf({ condition: 'a', quantity: 4 }) }), h)

    const { $push, $addToSet } = h.calls.updates[0].updateDoc
    assert.equal($push.exitOrders.$each[0].quantity, 4)
    assert.equal($push.exitOrders.$each[0].orderId, 'O9')
    assert.deepEqual($addToSet, { firedExits: 'stop:0' }, 'the tag is what stops this slice repeating')
})

// ── residual slices ──────────────────────────────────────────────────────────

test('an already-fired slice is skipped and its sibling still fires', async () => {
    const h = harness({ fires: [true] })   // consumed by slice 1 — slice 0 must never be evaluated
    await run(pos({
        firedExits: ['stop:0'],
        stopMonitorTree: residualOf({ condition: 'a', quantity: 3 }, { condition: 'b', quantity: 3 }),
    }), h)
    assert.equal(h.calls.orders.length, 1)
    assert.deepEqual(h.calls.updates[0].updateDoc.$addToSet, { firedExits: 'stop:1' })
})

test('two slices true in one tick each send their own order', async () => {
    const h = harness({ fires: [true, true] })
    await run(pos({
        quantity: 10,
        stopMonitorTree: residualOf({ condition: 'a', quantity: 3 }, { condition: 'b', quantity: 4 }),
    }), h)
    assert.deepEqual(h.calls.orders.map(o => o.order.quantity), [3, 4])
})

test('a residual slice with no quantity closes the whole position', async () => {
    const h = harness({ fires: [true] })
    await run(pos({ stopMonitorTree: residualOf({ condition: 'a' }) }), h)
    assert.equal(h.calls.closes.length, 1, 'null quantity is the full-close path, not a zero-size order')
    assert.deepEqual(h.calls.updates[0].updateDoc.$addToSet, { firedExits: 'stop:0' })
})

// ── the bookkeeping close ────────────────────────────────────────────────────

test('no broker position → onClose, and the hours gate is never consulted', async () => {
    const h = harness({ fires: [true], deferred: true })
    await run(pos({ stop_condition_tree: TREE, brokerOrders: [] }), h)
    assert.deepEqual(h.calls.closed, [{ id: 'e1', reason: 'stop' }])
    assert.deepEqual(h.calls.gates, [], 'there is nothing to send, so hours cannot gate it')
})

// ── additional entries ───────────────────────────────────────────────────────

test('a triggered additional entry is stamped, and only when no exit fired', async () => {
    const h = harness({ fires: [false, false, true] })   // stop, tp, then the entry
    await run(pos({
        stop_condition_tree: TREE, tp_condition_tree: TREE,
        additional_entries: [{ condition_tree: TREE, quantity: 5 }],
    }), h)
    assert.deepEqual(h.calls.closes, [], 'neither exit fired, so the position is untouched')
    assert.ok(h.calls.patches.some(p => p.fields['additional_entries.0.triggeredAt']))
})

test('an already-filled entry is skipped', async () => {
    const h = harness({ fires: [true] })
    await run(pos({ additional_entries: [{ filledAt: 1, condition_tree: TREE }] }), h)
    assert.deepEqual(h.calls.patches, [])
})

// ── the deferred replay ──────────────────────────────────────────────────────

test('the replay goes through the SAME close path as an in-hours stop', async () => {
    const h = harness()
    h.deps.getById = async () => pos({ brokerOrders: [LINK] })
    const res = await executeDeferredClose('e1', 'u1', { leg: 'stop', reason: 'stop' }, h.deps)
    assert.deepEqual(res, { ok: true })
    assert.equal(h.calls.closes.length, 1)
    assert.deepEqual(h.calls.patches.at(-1).fields, { orderState: null }, 'the park is released')
})

test('a position closed in the meantime is not a failure', async () => {
    const h = harness()
    h.deps.getById = async () => pos({ brokerOrders: [] })
    const res = await executeDeferredClose('e1', 'u1', {}, h.deps)
    assert.deepEqual(res, { ok: true, reason: 'already_closed' })
    assert.deepEqual(h.calls.closes, [])
})

test('the replay refuses another user\'s position', async () => {
    const h = harness()
    h.deps.getById = async () => pos({ userId: 'someone_else' })
    assert.deepEqual(await executeDeferredClose('e1', 'u1', {}, h.deps), { ok: false, reason: 'not_found' })
    assert.deepEqual(h.calls.closes, [], 'and sends nothing while refusing')
})
