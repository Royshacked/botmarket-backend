import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PaperAdapter } from '../../api/broker/adapters/paper.adapter.js'
import { paperBrokerService } from '../../api/broker/paperBroker.service.js'

// paperOrders is the ledger's source: `filled` rows are what trade history is built from. cancelOrder
// and amendOrder used to be an unconditional `$set` on the row, so a cancel that landed after the fill
// engine had claimed the order — a stale exitOrders record in the reconciler's fallback, or the user's
// ✕ a beat after the fill — flipped a FILLED row to 'cancelled'. Both now go through claimOrder with a
// `status:'working'` guard, the same primitive the fill engine claims with, and refuse otherwise —
// which is what a real venue answers to a cancel on a filled order.

const adapter = new PaperAdapter()

// Replace the store's claimOrder with a fake that records the call and answers as told. The adapter
// has no deps seam for the store (it imports the singleton), so the singleton is patched and restored.
const real = { claimOrder: paperBrokerService.claimOrder, listOrders: paperBrokerService.listOrders }
afterEach(() => Object.assign(paperBrokerService, real))

function fakeClaim(won) {
    const calls = []
    paperBrokerService.claimOrder = async (userId, orderId, guard, fields) => { calls.push({ userId, orderId, guard, fields }); return won }
    return calls
}

test('cancelOrder claims with a working guard and flips the row when it wins', async () => {
    const calls = fakeClaim(true)
    await adapter.cancelOrder('u1', 'paper-u1-a', 'o1')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].guard, { status: 'working' })
    assert.equal(calls[0].fields.status, 'cancelled')
    assert.ok(calls[0].fields.cancelledAt > 0)
})

test('cancelOrder REFUSES an order that is no longer working — a filled row stays filled', async () => {
    fakeClaim(false)
    await assert.rejects(
        () => adapter.cancelOrder('u1', 'paper-u1-a', 'o-filled'),
        /not working/,
    )
})

test('amendOrder re-prices under the same guard', async () => {
    const calls = fakeClaim(true)
    const r = await adapter.amendOrder('u1', 'paper-u1-a', 'o1', { stopPrice: 101.5 })
    assert.deepEqual(r, { orderId: 'o1' })
    assert.deepEqual(calls[0].guard, { status: 'working' })
    assert.equal(calls[0].fields.triggerPrice, 101.5)
    assert.ok(calls[0].fields.amendedAt > 0, 'stamps a change even when the price is unchanged, so a same-price amend is not read as "not working"')
})

test('amendOrder refuses a non-working order and still insists on a price', async () => {
    fakeClaim(false)
    await assert.rejects(() => adapter.amendOrder('u1', 'paper-u1-a', 'o-filled', { limitPrice: 5 }), /not working/)
    await assert.rejects(() => adapter.amendOrder('u1', 'paper-u1-a', 'o1', {}), /requires a new limitPrice or stopPrice/)
})

// listOrders ignored accountId, so `/api/broker/paper/orders?accountId=A` returned account B's
// resting orders too. The store already filters on it; the adapter now passes it through.
test('listOrders scopes to the named account and passes none through for the generic dispatch', async () => {
    const seen = []
    paperBrokerService.listOrders = async (userId, filter) => { seen.push(filter); return [] }
    await adapter.listOrders('u1', 'paper-u1-a')
    await adapter.listOrders('u1')
    assert.deepEqual(seen[0], { status: 'working', accountId: 'paper-u1-a' })
    assert.deepEqual(seen[1], { status: 'working', accountId: undefined })
})
