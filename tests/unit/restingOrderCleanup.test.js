import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cancelRestingEntryOrders } from '../../services/restingOrders.service.js'

// A working ENTRY order is one the entity placed that has not become a position. Three paths pull
// them — an idea leaving 'resting', a setup's limit order being disarmed, and either being deleted —
// and they used to hold three copies of this loop.
//
// THE DELETE CASE IS WHY THIS MATTERS. A `hit` setup is not delete-locked (only long/short are), and
// a confirmed limit entry rests at the broker while the setup waits at `hit`. Deleting the document
// without pulling the order left it working with nothing tracking it: it would fill later and the
// reconciler would find no entity for the fill. The idea path had guarded that since it gained
// resting entries; the setup path had not.

function spy(failOn = []) {
    const calls = []
    return {
        calls,
        cancelOrder: async (broker, userId, accountId, orderId) => {
            calls.push({ broker, userId, accountId, orderId })
            if (failOn.includes(orderId)) throw new Error('broker said no')
        },
    }
}

const ENTITY = {
    id: 'setup_NVDA_1', userId: 'u1',
    brokerOrders: [
        { broker: 'ctrader', accountId: 'a1', orderId: 'o1', positionId: null },
        { broker: 'ctrader', accountId: 'a2', orderId: 'o2', positionId: null },
    ],
}

test('every working entry order is cancelled, on its own account', async () => {
    const s = spy()
    const res = await cancelRestingEntryOrders(ENTITY, 'u1', { cancelOrder: s.cancelOrder })
    assert.deepEqual(res, { cancelled: 2, failed: 0 })
    assert.deepEqual(s.calls.map(c => [c.accountId, c.orderId]), [['a1', 'o1'], ['a2', 'o2']])
    assert.equal(s.calls[0].userId, 'u1')
})

// The one test that matters for money: an order that FILLED is a position, and cancelling against a
// netting venue is how a closed position comes back the other way.
test('a leg that already became a position is never cancelled', async () => {
    const s = spy()
    const filled = { ...ENTITY, brokerOrders: [
        { broker: 'ctrader', accountId: 'a1', orderId: 'o1', positionId: 'p1' },
        { broker: 'ctrader', accountId: 'a2', orderId: 'o2', positionId: null },
    ] }
    const res = await cancelRestingEntryOrders(filled, 'u1', { cancelOrder: s.cancelOrder })
    assert.deepEqual(res, { cancelled: 1, failed: 0 })
    assert.deepEqual(s.calls.map(c => c.orderId), ['o2'], 'only the unfilled one')
})

test('a leg with no orderId is skipped — there is nothing at the broker', async () => {
    const s = spy()
    const res = await cancelRestingEntryOrders({ brokerOrders: [{ broker: 'paper', accountId: 'a1', orderId: null, positionId: null }] }, 'u1', { cancelOrder: s.cancelOrder })
    assert.deepEqual(res, { cancelled: 0, failed: 0 })
    assert.equal(s.calls.length, 0)
})

// Best-effort on purpose: the caller is on its way to a state where the entity stops tracking these
// orders, so stopping at the first failure leaves MORE orphans than carrying on.
test('one broker refusing does not strand the rest', async () => {
    const s = spy(['o1'])
    const res = await cancelRestingEntryOrders(ENTITY, 'u1', { cancelOrder: s.cancelOrder })
    assert.deepEqual(res, { cancelled: 1, failed: 1 })
    assert.deepEqual(s.calls.map(c => c.orderId), ['o1', 'o2'], 'it kept going')
})

test('no linkage at all is not an error', async () => {
    const s = spy()
    for (const e of [null, {}, { brokerOrders: null }, { brokerOrders: [] }]) {
        assert.deepEqual(await cancelRestingEntryOrders(e, 'u1', { cancelOrder: s.cancelOrder }), { cancelled: 0, failed: 0 })
    }
    assert.equal(s.calls.length, 0)
})
