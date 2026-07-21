import { test } from 'node:test'
import assert from 'node:assert/strict'

import { KINDS, ownerForKind, isKind, blankMonitorState, blankExecution } from '../../services/entity/envelope.js'
import { ideaToEnvelope, callToEnvelope, toEnvelope } from '../../services/entity/toEnvelope.js'
import { buildFilter, makeEntityStore } from '../../services/entity/entityStore.service.js'

// P0 of the entity split (ENTITY_MODEL.md). These are the pure seams the blind execution path
// and the migrations will stand on: owner-from-kind, the legacy→envelope adapters (incl. the
// idea camelCase vs call snake_case mismatch), and the sparse entity-store filter.

// ── owner is derived from kind, never stored ──────────────────────────────────────────────
test('ownerForKind maps each execution-tier kind to its monitor', () => {
    assert.equal(ownerForKind(KINDS.IDEA),           'minos')
    assert.equal(ownerForKind(KINDS.CALL),           'hermes')
    assert.equal(ownerForKind(KINDS.PORTFOLIO_ITEM), 'themis')
    assert.equal(ownerForKind('nope'), null)
})

test('isKind guards the discriminator', () => {
    assert.equal(isKind('idea'), true)
    assert.equal(isKind('portfolio_item'), true)
    assert.equal(isKind('book'), false)
})

test('blank helpers are fresh (not shared references)', () => {
    const a = blankMonitorState(), b = blankMonitorState()
    a.timeline.push('x')
    assert.deepEqual(b.timeline, [])           // no shared array
    assert.equal(blankExecution().basisOffset, 0)
    assert.deepEqual(blankExecution().brokerOrders, [])
})

// ── idea → envelope ───────────────────────────────────────────────────────────────────────
test('ideaToEnvelope maps a standalone idea, kind=idea', () => {
    const doc = {
        id: 'i1', userId: 'u1', status: 'looking', asset: 'AAPL', asset_class: 'equity',
        direction: 'long', savedAt: 1000, quantity: 100,
        broker: 'ctrader', accounts: ['a1'], mainAccountId: 'a1',
        brokerSymbol: 'AAPL.US', basisOffset: 2, orderState: 'placed',
        brokerOrders: [{ orderId: 'o1' }],
    }
    const e = ideaToEnvelope(doc)
    assert.equal(e.kind, KINDS.IDEA)
    assert.equal(e.owner, 'minos')
    assert.equal(e.parentId, null)
    assert.equal(e.userId, 'u1')
    assert.equal(e.asset, 'AAPL')
    assert.equal(e.assetClass, 'equity')
    assert.equal(e.createdAt, 1000)
    assert.deepEqual(e.execution, {
        broker: 'ctrader', accounts: ['a1'], mainAccountId: 'a1',
        brokerSymbol: 'AAPL.US', basisOffset: 2, orderState: 'placed',
        brokerOrders: [{ orderId: 'o1' }],
    })
    assert.deepEqual(e.sizing, { unit: 'shares', requested: 100, resolvedQty: 100 })
    assert.equal(e.payload, doc)               // non-destructive strangler view
})

test('ideaToEnvelope surfaces a portfolio holding as kind=portfolio_item with parentId', () => {
    const e = ideaToEnvelope({ id: 'h1', userId: 'u1', status: 'long', asset: 'MSFT', portfolioId: 'bk1' })
    assert.equal(e.kind, KINDS.PORTFOLIO_ITEM)
    assert.equal(e.owner, 'themis')
    assert.equal(e.parentId, 'bk1')
})

test('ideaToEnvelope tolerates a sparse doc (missing execution/sizing fields)', () => {
    const e = ideaToEnvelope({ id: 'i2', status: 'waiting' })
    assert.equal(e.execution.basisOffset, 0)
    assert.deepEqual(e.execution.accounts, [])
    assert.deepEqual(e.execution.brokerOrders, [])
    assert.equal(e.sizing.requested, null)
    assert.deepEqual(e.monitorState, blankMonitorState())
})

test('ideaToEnvelope(null) → null', () => {
    assert.equal(ideaToEnvelope(null), null)
})

// ── call → envelope (snake_case → camelCase) ────────────────────────────────────────────────
test('callToEnvelope absorbs the snake_case field names', () => {
    const doc = {
        id: 'call_TSLA_abc', user_id: 'u9', status: 'watching', asset: 'TSLA', asset_class: 'equity',
        bias: 'long', savedAt: 2000, broker: 'paper', accounts: ['pa1'], main_account_id: 'pa1',
        broker_symbol: 'TSLA', basis_offset: 0, sizing: { max_size: 50, unit: 'shares' },
        monitor_state: { next_check_at: 5, check_count: 3, memo: 'mm', timeline: [{ t: 1 }] },
    }
    const e = callToEnvelope(doc)
    assert.equal(e.kind, KINDS.CALL)
    assert.equal(e.owner, 'hermes')
    assert.equal(e.userId, 'u9')                       // ← user_id
    assert.equal(e.direction, 'long')                  // ← bias
    assert.equal(e.execution.mainAccountId, 'pa1')     // ← main_account_id
    assert.equal(e.execution.brokerSymbol, 'TSLA')     // ← broker_symbol
    // orderState/brokerOrders live on the idea shadow until P3 — null/[] by design:
    assert.equal(e.execution.orderState, null)
    assert.deepEqual(e.execution.brokerOrders, [])
    assert.deepEqual(e.sizing, { unit: 'shares', requested: 50, resolvedQty: null })
    assert.deepEqual(e.monitorState, { nextCheckAt: 5, checkCount: 3, memo: 'mm', timeline: [{ t: 1 }] })
})

test('toEnvelope dispatches by source tag', () => {
    assert.equal(toEnvelope({ id: 'c', user_id: 'u' }, 'call').kind, KINDS.CALL)
    assert.equal(toEnvelope({ id: 'i', userId: 'u' }, 'idea').kind, KINDS.IDEA)
    assert.equal(toEnvelope({ id: 'x', userId: 'u' }).kind, KINDS.IDEA)   // default
})

// ── entity-store filter + CRUD over an in-memory fake ───────────────────────────────────────
test('buildFilter omits undefined selectors and $in-wraps a status array', () => {
    assert.deepEqual(buildFilter({}), {})
    assert.deepEqual(buildFilter({ kind: 'idea' }), { kind: 'idea' })
    assert.deepEqual(buildFilter({ kind: 'idea', userId: 'u1' }), { kind: 'idea', userId: 'u1' })
    assert.deepEqual(buildFilter({ status: ['looking', 'long'] }), { status: { $in: ['looking', 'long'] } })
    assert.deepEqual(buildFilter({ parentId: null }), { parentId: null })   // null IS a real selector
})

test('entityStore CRUD works against an injected collection', async () => {
    const docs = []
    const fakeColl = {
        async findOne(f) { return docs.find(d => d.id === f.id) ?? null },
        find(f) { return { async toArray() { return docs.filter(d => Object.entries(f).every(([k, v]) => d[k] === v)) } } },
        async insertOne(d) { docs.push(d) },
        async updateOne(f, u) { Object.assign(docs.find(d => d.id === f.id), u.$set) },
        async deleteOne(f) { const i = docs.findIndex(d => d.id === f.id); if (i >= 0) docs.splice(i, 1) },
    }
    const store = makeEntityStore({ coll: async () => fakeColl })

    await store.insert({ id: 'e1', kind: 'idea', userId: 'u1', status: 'looking' })
    await store.insert({ id: 'e2', kind: 'call', userId: 'u1', status: 'watching' })

    assert.equal((await store.getById('e1')).status, 'looking')
    assert.deepEqual((await store.query({ kind: 'idea' })).map(d => d.id), ['e1'])

    const patched = await store.patch('e1', { status: 'hit' })
    assert.equal(patched.status, 'hit')

    await store.remove('e2')
    assert.equal(await store.getById('e2'), null)
})
