import { test } from 'node:test'
import assert from 'node:assert/strict'

import { KINDS, ownerForKind, isKind, kindForDoc, blankMonitorState, blankExecution } from '../../services/entity/envelope.js'
import { ideaToEnvelope, callToEnvelope, toEnvelope } from '../../services/entity/toEnvelope.js'

// P0 of the entity split (docs/architecture/entity-model.md). These are the pure seams the blind execution path
// stands on: owner-from-kind and the legacy→envelope adapters (incl. the idea camelCase vs call
// snake_case mismatch).
//
// The third P0 seam, entityStore, was DELETED 2026-08-07 along with its two tests — the migration
// went a different way and nothing ever consumed it. See docs/architecture/entity-model.md.

// ── owner is derived from kind, never stored ──────────────────────────────────────────────
test('ownerForKind maps each execution-tier kind to its monitor', () => {
    // NULL is a real answer, not a gap. Minos was deleted and Hermes archived (2026-08-18), so
    // nothing watches a loose idea or a call — which is only safe because neither is authored any
    // more. Naming a monitor that is not running is the worse failure: a caller asking "who is
    // responsible for this going stale?" gets a confident pointer at a file that never ticks.
    assert.equal(ownerForKind(KINDS.IDEA),           null)
    assert.equal(ownerForKind(KINDS.CALL),           null)
    assert.equal(ownerForKind(KINDS.PORTFOLIO_ITEM), 'themis',
        'a HOLDING rides the idea kind but resolves as portfolio_item — the execution tier keeps its watcher')
    assert.equal(ownerForKind('nope'), null)
})

test('isKind guards the discriminator', () => {
    assert.equal(isKind('idea'), true)
    assert.equal(isKind('portfolio_item'), true)
    assert.equal(isKind('book'), false)
})

test('kindForDoc: a holding (portfolioId) → portfolio_item, else idea', () => {
    assert.equal(kindForDoc({ portfolioId: 'bk1' }), KINDS.PORTFOLIO_ITEM)
    assert.equal(kindForDoc({ portfolioId: null }), KINDS.IDEA)
    assert.equal(kindForDoc({}), KINDS.IDEA)
    assert.equal(kindForDoc(undefined), KINDS.IDEA)   // migration-safe on sparse input
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
    assert.equal(e.owner, null)   // Minos deleted 2026-08-18
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

// ── call → envelope (snake_case payload → camelCase) ────────────────────────────────────────
test('callToEnvelope absorbs the snake_case field names', () => {
    const doc = {
        id: 'call_TSLA_abc', userId: 'u9', status: 'watching', asset: 'TSLA', asset_class: 'equity',
        bias: 'long', savedAt: 2000, broker: 'paper', accounts: ['pa1'], main_account_id: 'pa1',
        broker_symbol: 'TSLA', basis_offset: 0, sizing: { max_size: 50, unit: 'shares' },
        monitor_state: { next_check_at: 5, check_count: 3, memo: 'mm', timeline: [{ t: 1 }] },
    }
    const e = callToEnvelope(doc)
    assert.equal(e.kind, KINDS.CALL)
    assert.equal(e.owner, null)   // Hermes archived 2026-08-18
    assert.equal(e.userId, 'u9')                       // envelope field — one name for every kind
    assert.equal(e.direction, 'long')                  // ← bias
    assert.equal(e.execution.mainAccountId, 'pa1')     // ← main_account_id
    assert.equal(e.execution.brokerSymbol, 'TSLA')     // ← broker_symbol
    // Pre-P3b these were hard-coded null/[] because execution lived on an idea shadow. A confirmed
    // call now carries its own, and reporting a linked call as unlinked is how a live position
    // loses its owner — so they must read THROUGH.
    assert.equal(e.execution.orderState, null)          // this fixture is pre-entry
    assert.deepEqual(e.execution.brokerOrders, [])
    assert.deepEqual(e.sizing, { unit: 'shares', requested: 50, resolvedQty: null })
    assert.deepEqual(e.monitorState, { nextCheckAt: 5, checkCount: 3, memo: 'mm', timeline: [{ t: 1 }] })
})

test('callToEnvelope reads a CONFIRMED call\'s own execution (no idea shadow since P3b)', () => {
    const e = callToEnvelope({
        id: 'call_TSLA_abc', userId: 'u9', status: 'long', asset: 'TSLA',
        orderState: 'placed',
        brokerOrders: [{ broker: 'paper', accountId: 'pa1', positionId: 'p9' }],
    })
    assert.equal(e.execution.orderState, 'placed')
    assert.deepEqual(e.execution.brokerOrders, [{ broker: 'paper', accountId: 'pa1', positionId: 'p9' }])
})

test('toEnvelope dispatches by source tag', () => {
    assert.equal(toEnvelope({ id: 'c', userId: 'u' }, 'call').kind, KINDS.CALL)
    assert.equal(toEnvelope({ id: 'i', userId: 'u' }, 'idea').kind, KINDS.IDEA)
    assert.equal(toEnvelope({ id: 'x', userId: 'u' }).kind, KINDS.IDEA)   // default
})
