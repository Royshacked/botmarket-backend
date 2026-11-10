import { test } from 'node:test'
import assert from 'node:assert/strict'

import { KINDS, ownerForKind, isKind, kindForDoc, blankMonitorState, blankExecution } from '../../services/entity/envelope.js'
import { ideaToEnvelope, toEnvelope } from '../../services/entity/toEnvelope.js'

// P0 of the entity split (docs/architecture/entity-model.md). These are the pure seams the blind execution path
// stands on: owner-from-kind and the legacy→envelope adapters (incl. the idea's camelCase).
//
// The third P0 seam, entityStore, was DELETED 2026-08-07 along with its two tests — the migration
// went a different way and nothing ever consumed it. See docs/architecture/entity-model.md.

// ── owner is derived from kind, never stored ──────────────────────────────────────────────
test('ownerForKind maps each execution-tier kind to its monitor', () => {
    // NULL is a real answer, not a gap. Minos was deleted, so no single monitor owns a loose
    // idea. Naming a monitor that is not running is the worse failure: a caller asking "who is
    // responsible for this going stale?" gets a confident pointer at a file that never ticks.
    assert.equal(ownerForKind(KINDS.IDEA),           null)
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
    a.memo = 'x'
    assert.equal(b.memo, null)                 // no shared object
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
    assert.deepEqual(e.monitorState, blankMonitorState(), 'an idea nothing has checked yet still reports a blank schedule')
})

test('an idea the entry or exit loop has scheduled reports ITS wake-up time', () => {
    // It used to hard-blank this and say "no loop polls the kind". Two do.
    const e = ideaToEnvelope({ id: 'i9', monitor_state: { next_check_at: '2026-08-18T20:00:00.000Z' } })
    assert.equal(e.monitorState.nextCheckAt, '2026-08-18T20:00:00.000Z')
    assert.equal(e.monitorState.checkCount, 0)
})

test('ideaToEnvelope(null) → null', () => {
    assert.equal(ideaToEnvelope(null), null)
})

test('toEnvelope reads every source as an idea (the call kind was deleted 2026-11-10)', () => {
    assert.equal(isKind('call'), false)
    assert.equal(toEnvelope({ id: 'i', userId: 'u' }, 'idea').kind, KINDS.IDEA)
    assert.equal(toEnvelope({ id: 'x', userId: 'u' }).kind, KINDS.IDEA)   // default
})

// ── the kind enum answers about the kinds that exist ─────────────────────────
//
// `setup` was missing from KINDS while living in `entities`, carrying brokerOrders and going
// through positionManage like the other two. So isKind('setup') answered false about a kind that
// plainly exists, and ownerForKind('setup') answered null — "no monitor" — about the one kind with
// a single, named, actually-running owner.

test('setup is an execution-tier kind, like the others in `entities`', () => {
    assert.equal(isKind('setup'), true)
    assert.equal(isKind('idea'), true)
    assert.equal(isKind('portfolio_item'), true)
})

test('a book is NOT a kind — it is the set of items carrying its id', () => {
    // Guards against "unifying" the watchlist/chat vocabulary into this enum. `portfolio` there
    // names the BOOK; `portfolio_item` here names one holding. Different things, not two spellings.
    assert.equal(isKind('portfolio'), false)
    // Research artifacts live in their own collections with no execution tier.
    assert.equal(isKind('coverage'), false)
    assert.equal(isKind('scan'), false)
})

test('the kind with one named monitor says so', () => {
    // Talos polls kind:'setup' exclusively, and the entry/exit loops both exclude it.
    assert.equal(ownerForKind('setup'), 'talos')
    assert.equal(ownerForKind('portfolio_item'), 'themis')
})

test('null means no SINGLE owner, not unwatched', () => {
    // The distinction that grew teeth when the entry and exit loops became kind-blind: an idea IS
    // watched by both, but by loops this map cannot name. Reading null as "nothing is looking at
    // this" is wrong in the dangerous direction.
    assert.equal(ownerForKind('idea'), null)
    assert.equal(ownerForKind('nonsense'), null)
})
