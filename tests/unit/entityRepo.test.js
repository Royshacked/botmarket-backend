import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeEntityRepo, ACTIVE_STATUSES } from '../../services/entity/entityRepo.service.js'

// P1b faithfulness net (ENTITY_MODEL.md): entityRepo is a behavior-preserving indirection over the
// execution path's inline db.collection('ideas') calls. These assert each method issues the EXACT
// filter/update/options the reconciler used inline — so migrating the reconciler onto entityRepo
// cannot silently change a query. End-to-end semantics are covered separately by the regression harness.

/** A spy collection: records every call's args, returns canned values. */
function spyColl(returns = {}) {
    const calls = []
    const coll = {
        calls,
        async findOne(...a) { calls.push(['findOne', ...a]); return returns.findOne ?? null },
        find(...a) { calls.push(['find', ...a]); return { toArray: async () => returns.find ?? [] } },
        async findOneAndUpdate(...a) { calls.push(['findOneAndUpdate', ...a]); return returns.findOneAndUpdate ?? null },
        async updateOne(...a) { calls.push(['updateOne', ...a]); return returns.updateOne ?? { modifiedCount: 1 } },
        async updateMany(...a) { calls.push(['updateMany', ...a]); return returns.updateMany ?? { modifiedCount: 0 } },
    }
    return { coll, repo: makeEntityRepo({ coll: async () => coll }) }
}

test('findActiveByPosition → findOne active + brokerOrders elemMatch (String-coerced)', async () => {
    const { coll, repo } = spyColl()
    await repo.findActiveByPosition(42, 99)   // numbers → must be stringified
    assert.deepEqual(coll.calls[0], ['findOne', {
        status: { $in: ACTIVE_STATUSES },
        brokerOrders: { $elemMatch: { accountId: '42', positionId: '99' } },
    }])
})

test('findLinkedByPosition → findOne brokerOrders elemMatch only', async () => {
    const { coll, repo } = spyColl()
    await repo.findLinkedByPosition('a1', 'p1')
    assert.deepEqual(coll.calls[0], ['findOne', {
        brokerOrders: { $elemMatch: { accountId: 'a1', positionId: 'p1' } },
    }])
})

test('claimRestingFill → findOneAndUpdate resting + $[slot] arrayFilter + returnDocument after', async () => {
    const { coll, repo } = spyColl({ findOneAndUpdate: { id: 'x' } })
    const set = {
        status: 'long', orderState: 'placed', ordersPlacedAt: 1, activatedAt: 1,
        'brokerOrders.$[slot].positionId': '99',
    }
    const out = await repo.claimRestingFill('a1', 'o1', set)
    assert.deepEqual(out, { id: 'x' })
    assert.deepEqual(coll.calls[0], ['findOneAndUpdate',
        { status: 'resting', brokerOrders: { $elemMatch: { accountId: 'a1', orderId: 'o1' } } },
        { $set: set },
        { arrayFilters: [{ 'slot.accountId': 'a1', 'slot.orderId': 'o1' }], returnDocument: 'after' },
    ])
})

test('backfillPositionId (no symbol) → active + unlinked-slot elemMatch + $[slot] arrayFilter', async () => {
    const { coll, repo } = spyColl()
    await repo.backfillPositionId('a1', 'p9')
    assert.deepEqual(coll.calls[0], ['findOneAndUpdate',
        { status: { $in: ACTIVE_STATUSES }, brokerOrders: { $elemMatch: { accountId: 'a1', positionId: null } } },
        { $set: { 'brokerOrders.$[slot].positionId': 'p9' } },
        { arrayFilters: [{ 'slot.accountId': 'a1', 'slot.positionId': null }], returnDocument: 'after' },
    ])
})

test('backfillPositionId (with symbol) constrains on asset', async () => {
    const { coll, repo } = spyColl()
    await repo.backfillPositionId('a1', 'p9', 'AAPL')
    assert.equal(coll.calls[0][1].asset, 'AAPL')
})

test('activeWithBrokerLinks → find active+resting w/ links, correct projection', async () => {
    const { coll, repo } = spyColl({ find: [{ id: 'i1' }] })
    const out = await repo.activeWithBrokerLinks()
    assert.deepEqual(out, [{ id: 'i1' }])
    assert.deepEqual(coll.calls[0], ['find',
        { status: { $in: ['long', 'short', 'resting'] }, brokerOrders: { $exists: true, $ne: [] } },
        { projection: { userId: 1, brokerOrders: 1 } },
    ])
})

test('patch → updateOne {id} $set', async () => {
    const { coll, repo } = spyColl()
    await repo.patch('i1', { orderState: 'placed' })
    assert.deepEqual(coll.calls[0], ['updateOne', { id: 'i1' }, { $set: { orderState: 'placed' } }])
})

test('finalizeClose → guarded findOneAndUpdate {id, status:$in ACTIVE} returning doc', async () => {
    const { coll, repo } = spyColl({ findOneAndUpdate: { id: 'i1', status: 'closed' } })
    const patch = { status: 'closed', closedReason: 'tp', closedAt: 5, realizedPnl: 12 }
    const out = await repo.finalizeClose('i1', patch)
    assert.deepEqual(out, { id: 'i1', status: 'closed' })
    assert.deepEqual(coll.calls[0], ['findOneAndUpdate',
        { id: 'i1', status: { $in: ACTIVE_STATUSES } },
        { $set: patch },
        { returnDocument: 'after' },
    ])
})

test('claimExitAccount → atomic $addToSet under $ne; returns true iff this call won', async () => {
    const won = spyColl({ updateOne: { modifiedCount: 1 } })
    assert.equal(await won.repo.claimExitAccount('i1', 7), true)
    assert.deepEqual(won.coll.calls[0], ['updateOne',
        { id: 'i1', exitPlacedAccounts: { $ne: '7' } },
        { $addToSet: { exitPlacedAccounts: '7' } },
    ])

    const lost = spyColl({ updateOne: { modifiedCount: 0 } })
    assert.equal(await lost.repo.claimExitAccount('i1', 7), false)   // already claimed
})

test('pushExitOrders / setExitOrders → correct $push / $set', async () => {
    const { coll, repo } = spyColl()
    await repo.pushExitOrders('i1', [{ leg: 'tp' }])
    assert.deepEqual(coll.calls[0], ['updateOne', { id: 'i1' }, { $push: { exitOrders: { $each: [{ leg: 'tp' }] } } }])
    await repo.setExitOrders('i1', [{ leg: 'stop', status: 'cancelled' }])
    assert.deepEqual(coll.calls[1], ['updateOne', { id: 'i1' }, { $set: { exitOrders: [{ leg: 'stop', status: 'cancelled' }] } }])
})

// ── methods added for the ideaExecution / manualIdea / positionMonitor migration ─────────────
test('patchAndGet → findOneAndUpdate {id} $set returnDocument after', async () => {
    const { coll, repo } = spyColl({ findOneAndUpdate: { id: 'i1', status: 'long' } })
    const out = await repo.patchAndGet('i1', { status: 'long', orderState: 'placed' })
    assert.deepEqual(out, { id: 'i1', status: 'long' })
    assert.deepEqual(coll.calls[0], ['findOneAndUpdate',
        { id: 'i1' }, { $set: { status: 'long', orderState: 'placed' } }, { returnDocument: 'after' }])
})

test('claimIf → guarded findOneAndUpdate {id, ...guard} $set (default returnDocument)', async () => {
    const { coll, repo } = spyColl({ findOneAndUpdate: { id: 'i1' } })
    const out = await repo.claimIf('i1', { broker: 'manual', orderState: 'awaiting_manual_fill' }, { orderState: 'manual_filling' })
    assert.deepEqual(out, { id: 'i1' })   // truthy pre-image = won the claim
    assert.deepEqual(coll.calls[0], ['findOneAndUpdate',
        { id: 'i1', broker: 'manual', orderState: 'awaiting_manual_fill' },
        { $set: { orderState: 'manual_filling' } }])   // no options → default returnDocument
})

test('listByPortfolio → find({portfolioId[, userId]}); userId omitted when null', async () => {
    const scoped = spyColl({ find: [{ id: 'h1' }] })
    await scoped.repo.listByPortfolio('bk1', 'u1')
    assert.deepEqual(scoped.coll.calls[0], ['find', { portfolioId: 'bk1', userId: 'u1' }])

    const admin = spyColl({ find: [] })
    await admin.repo.listByPortfolio('bk1', null)
    assert.deepEqual(admin.coll.calls[0], ['find', { portfolioId: 'bk1' }])   // no userId scope
})

test('patchMany → updateMany {id:$in ids} $set', async () => {
    const { coll, repo } = spyColl({ updateMany: { modifiedCount: 2 } })
    await repo.patchMany(['a', 'b'], { status: 'hit', orderState: 'awaiting_manual_fill' })
    assert.deepEqual(coll.calls[0], ['updateMany',
        { id: { $in: ['a', 'b'] } }, { $set: { status: 'hit', orderState: 'awaiting_manual_fill' } }])
})

test('update → generic raw updateOne {id} (mixed $set/$addToSet/$push pass through)', async () => {
    const { coll, repo } = spyColl()
    const doc = { $set: { pendingCloseReason: 'stop' }, $addToSet: { firedExits: 'stop:0' } }
    await repo.update('i1', doc)
    assert.deepEqual(coll.calls[0], ['updateOne', { id: 'i1' }, doc])
})
