import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _addToItem } from '../../api/portfolio/portfolioRebalance.service.js'

// G3 — scale INTO a live holding. Guards (not-live / bad fraction / no position / manual), per-leg
// sizing (floor(qty × addFraction), same direction, no positionId), and the new-leg linkage.

// Fake db: one collection with a fixed idea for findOne, recording updateOne calls.
function fakeDb(idea) {
    const updates = []
    return {
        _updates: updates,
        collection: () => ({
            findOne: async () => idea,
            updateOne: async (q, u) => { updates.push({ q, u }) },
        }),
    }
}

// Fake broker: cTrader tradable, manual not; records placeOrder calls; returns an orderId.
function fakeBroker({ tradable = new Set(['ctrader']) } = {}) {
    const placed = []
    const feeds  = []
    return {
        _placed: placed,
        _feeds:  feeds,
        capabilities: (b) => ({ trading: tradable.has(b) }),
        placeOrder: async (broker, userId, accountId, order) => {
            placed.push({ broker, userId, accountId, order })
            return { orderId: `ord-${accountId}`, accountId, positionId: null }
        },
        startExecutionFeed: (broker, userId, accountId) => { feeds.push({ broker, accountId }); return Promise.resolve() },
    }
}

const liveIdea = (over = {}) => ({
    id: 'i1', userId: 'u1', status: 'long', direction: 'long', asset: 'NVDA', brokerSymbol: 'NVDA',
    brokerOrders: [
        { broker: 'ctrader', accountId: 'a1', positionId: 'p1', quantity: 10 },
        { broker: 'ctrader', accountId: 'a2', positionId: 'p2', quantity: 4 },
    ],
    ...over,
})

test('happy path: adds floor(qty × fraction) per leg, same direction, no positionId; links new legs', async () => {
    const db = fakeDb(liveIdea())
    const broker = fakeBroker()
    const r = await _addToItem(db, 'i1', 'u1', { addFraction: 0.5, targetAllocationRatio: 0.3 }, broker)

    assert.deepEqual(r, { ok: true, legsAdded: 2, legsSkipped: 0 })
    // 10×0.5=5, 4×0.5=2
    assert.deepEqual(broker._placed.map(p => p.order.quantity), [5, 2])
    assert.ok(broker._placed.every(p => p.order.direction === 'long' && p.order.type === 'market'))
    assert.ok(broker._placed.every(p => !('positionId' in p.order)))   // no positionId → opens/increases

    // One $push linking the two new legs (orderId set, positionId null), plus one $set for the weight.
    const push = db._updates.find(u => u.u.$push)
    assert.equal(push.u.$push.brokerOrders.$each.length, 2)
    assert.equal(push.u.$push.brokerOrders.$each[0].orderId, 'ord-a1')
    assert.equal(push.u.$push.brokerOrders.$each[0].positionId, null)
    const set = db._updates.find(u => u.u.$set)
    assert.equal(set.u.$set.allocationRatio, 0.3)
    assert.equal(broker._feeds.length, 2)   // listening for the fills
})

test('fraction > 1 is allowed (double the position)', async () => {
    const db = fakeDb(liveIdea({ brokerOrders: [{ broker: 'ctrader', accountId: 'a1', positionId: 'p1', quantity: 10 }] }))
    const broker = fakeBroker()
    const r = await _addToItem(db, 'i1', 'u1', { addFraction: 1.5 }, broker)
    assert.equal(r.legsAdded, 1)
    assert.equal(broker._placed[0].order.quantity, 15)
})

test('short holding adds on the short side', async () => {
    const db = fakeDb(liveIdea({ direction: 'short', status: 'short' }))
    const broker = fakeBroker()
    await _addToItem(db, 'i1', 'u1', { addFraction: 0.5 }, broker)
    assert.ok(broker._placed.every(p => p.order.direction === 'short'))
})

test('legs on a non-trading broker are skipped, not placed', async () => {
    const db = fakeDb(liveIdea({ brokerOrders: [
        { broker: 'ctrader', accountId: 'a1', positionId: 'p1', quantity: 10 },
        { broker: 'ibkr',    accountId: 'a2', positionId: 'p2', quantity: 8 },
    ] }))
    const broker = fakeBroker({ tradable: new Set(['ctrader']) })
    const r = await _addToItem(db, 'i1', 'u1', { addFraction: 0.5 }, broker)
    assert.deepEqual(r, { ok: true, legsAdded: 1, legsSkipped: 1 })
    assert.equal(broker._placed.length, 1)
})

test('a fraction that floors a leg to 0 is skipped', async () => {
    const db = fakeDb(liveIdea({ brokerOrders: [{ broker: 'ctrader', accountId: 'a1', positionId: 'p1', quantity: 1 }] }))
    const broker = fakeBroker()
    const r = await _addToItem(db, 'i1', 'u1', { addFraction: 0.4 }, broker)   // floor(0.4)=0
    assert.deepEqual(r, { ok: false, legsAdded: 0, legsSkipped: 1 })
    assert.equal(broker._placed.length, 0)
})

test('one leg failing does not abandon the other: the placed leg is still linked', async () => {
    const db = fakeDb(liveIdea())
    const broker = fakeBroker()
    // Fail the a2 leg; a1 must still be placed AND linked.
    broker.placeOrder = async (b, u, accountId, order) => {
        if (accountId === 'a2') throw new Error('broker rejected')
        return { orderId: `ord-${accountId}`, accountId, positionId: null }
    }
    const r = await _addToItem(db, 'i1', 'u1', { addFraction: 0.5 }, broker)
    assert.equal(r.ok, true)
    assert.equal(r.legsAdded, 1)
    assert.equal(r.legsFailed, 1)
    const push = db._updates.find(u => u.u.$push)
    assert.equal(push.u.$push.brokerOrders.$each.length, 1)
    assert.equal(push.u.$push.brokerOrders.$each[0].accountId, 'a1')
})

// ── guards ──
test('not-live holding → not_live (route new names through add_idea)', async () => {
    const db = fakeDb(liveIdea({ status: 'waiting' }))
    const r = await _addToItem(db, 'i1', 'u1', { addFraction: 0.5 }, fakeBroker())
    assert.deepEqual(r, { ok: false, reason: 'not_live' })
})
test('addFraction ≤ 0 or non-numeric → bad_addFraction', async () => {
    const db = fakeDb(liveIdea())
    assert.equal((await _addToItem(db, 'i1', 'u1', { addFraction: 0 }, fakeBroker())).reason, 'bad_addFraction')
    assert.equal((await _addToItem(db, 'i1', 'u1', { addFraction: -1 }, fakeBroker())).reason, 'bad_addFraction')
    assert.equal((await _addToItem(db, 'i1', 'u1', {}, fakeBroker())).reason, 'bad_addFraction')
})
test('no open position → no_position', async () => {
    const db = fakeDb(liveIdea({ brokerOrders: [{ broker: 'ctrader', accountId: 'a1', positionId: null, quantity: 10 }] }))
    const r = await _addToItem(db, 'i1', 'u1', { addFraction: 0.5 }, fakeBroker())
    assert.deepEqual(r, { ok: false, reason: 'no_position' })
})
test('manual leg → manual_add_unsupported (no programmatic placement)', async () => {
    const db = fakeDb(liveIdea({ brokerOrders: [{ broker: 'manual', accountId: 'a1', positionId: 'p1', quantity: 10 }] }))
    const r = await _addToItem(db, 'i1', 'u1', { addFraction: 0.5 }, fakeBroker())
    assert.deepEqual(r, { ok: false, reason: 'manual_add_unsupported' })
})
test('wrong owner → forbidden', async () => {
    const db = fakeDb(liveIdea({ userId: 'someone_else' }))
    const r = await _addToItem(db, 'i1', 'u1', { addFraction: 0.5 }, fakeBroker())
    assert.deepEqual(r, { ok: false, reason: 'forbidden' })
})
