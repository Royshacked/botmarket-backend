import { test } from 'node:test'
import assert from 'node:assert/strict'

import { executionReconciler, _setDeps } from '../../monitoring/execution.reconciler.js'
import { makeEntityRepo } from '../../services/entity/entityRepo.service.js'

// P1b regression harness (ENTITY_MODEL.md). Drives the REAL reconciler through the riskiest
// execution sequences against an in-memory Mongo double + fake broker/capture, and characterizes
// the ordered operation log + final entity state. This is the safety net: after the reconciler is
// migrated onto entityRepo (which relays the identical collection calls), this fixture must stay
// GREEN unchanged — the current behavior is the executable spec.

// ── in-memory Mongo double: implements only the operators the reconciler uses ────────────────
function makeMongoDouble(seed, opLog) {
    const store = new Map(seed.map(d => [d.id, structuredClone(d)]))
    const clone = d => (d ? structuredClone(d) : d)

    const matches = (doc, f) => Object.entries(f).every(([k, v]) => {
        if (k === 'status')  return v?.$in ? v.$in.includes(doc.status) : doc.status === v
        if (k === 'id')      return doc.id === v
        if (k === 'asset')   return doc.asset === v
        if (k === 'exitPlacedAccounts') return v?.$ne == null || !(doc.exitPlacedAccounts ?? []).map(String).includes(String(v.$ne))
        if (k === 'brokerOrders') {
            if (v.$elemMatch) return (doc.brokerOrders ?? []).some(b =>
                Object.entries(v.$elemMatch).every(([bk, bv]) => bv === null ? b[bk] == null : String(b[bk]) === String(bv)))
            if (v.$exists != null || v.$ne != null) {
                const arr = doc.brokerOrders
                if (v.$exists && arr === undefined) return false
                if (v.$ne !== undefined && JSON.stringify(arr) === JSON.stringify(v.$ne)) return false
                return true
            }
        }
        return true
    })

    const applySet = (doc, set, arrayFilters) => {
        for (const [path, val] of Object.entries(set)) {
            if (path.includes('$[slot]')) {
                const field = path.split('.').pop()
                const sf    = (arrayFilters ?? []).find(a => Object.keys(a).some(k => k.startsWith('slot.'))) ?? {}
                const cond  = Object.fromEntries(Object.entries(sf).map(([k, v]) => [k.replace('slot.', ''), v]))
                for (const b of doc.brokerOrders ?? []) {
                    if (Object.entries(cond).every(([ck, cv]) => cv === null ? b[ck] == null : String(b[ck]) === String(cv))) b[field] = val
                }
            } else doc[path] = val
        }
    }

    const coll = {
        async findOne(filter) {
            opLog.push('db:findOne')
            for (const d of store.values()) if (matches(d, filter)) return clone(d)
            return null
        },
        find(filter) {
            opLog.push('db:find')
            const res = [...store.values()].filter(d => matches(d, filter)).map(clone)
            return { toArray: async () => res }
        },
        async findOneAndUpdate(filter, update, opts = {}) {
            opLog.push('db:findOneAndUpdate')
            for (const d of store.values()) if (matches(d, filter)) { if (update.$set) applySet(d, update.$set, opts.arrayFilters); return clone(d) }
            return null
        },
        async updateOne(filter, update) {
            opLog.push('db:updateOne')
            for (const d of store.values()) if (matches(d, filter)) {
                if (update.$set)      applySet(d, update.$set)
                if (update.$addToSet) for (const [k, v] of Object.entries(update.$addToSet)) { d[k] ??= []; if (!d[k].includes(v)) d[k].push(v) }
                if (update.$push)     for (const [k, v] of Object.entries(update.$push))     { d[k] ??= []; d[k].push(...(v.$each ?? [v])) }
                return { modifiedCount: 1 }
            }
            return { modifiedCount: 0 }
        },
    }
    return { db: { collection: () => coll }, store }
}

const fakeBroker = (opLog, { listOrders = [], findOpenPosition = null } = {}) => ({
    async findOpenPosition() { opLog.push('broker:findOpenPosition'); return findOpenPosition },
    async placeOrder()       { opLog.push('broker:placeOrder');       return { orderId: `ord${opLog.filter(x => x === 'broker:placeOrder').length}` } },
    async cancelOrder()      { opLog.push('broker:cancelOrder');      return { ok: true } },
    async listOrders()       { opLog.push('broker:listOrders');       return listOrders },
    async startExecutionFeed() { opLog.push('broker:startFeed');      return true },
})

const fakeCapture = (opLog) => ({
    async captureOpen()     { opLog.push('capture:captureOpen') },
    async captureClose()    { opLog.push('capture:captureClose') },
    async captureOpenBare() { opLog.push('capture:captureOpenBare') },
})

function harness(seed, brokerOpts) {
    const opLog = []
    const { db, store } = makeMongoDouble(seed, opLog)
    const restore = _setDeps({
        getDb: async () => db,
        brokerService: fakeBroker(opLog, brokerOpts),
        tradeCaptureService: fakeCapture(opLog),
        // entityRepo now owns the reconciler's collection access — back it with the same double.
        entityRepo: makeEntityRepo({ coll: async () => db.collection() }),
    })
    return { opLog, store, restore }
}

// ── Scenario A: market entry → positionId backfill → native exits placed ─────────────────────
test('open→backfill→placeExits: op sequence + final linkage/exit state', async () => {
    const seed = [{
        id: 'idea1', userId: 'u1', asset: 'AAPL', direction: 'long', status: 'long', quantity: 100,
        brokerSymbol: 'AAPL', basisOffset: 0,
        brokerOrders: [{ accountId: 'a1', positionId: null, orderId: 'e1', broker: 'ctrader', quantity: 100 }],
        nativeExit: { stop: [{ level: 90, quantity: 100 }], tp: [{ level: 110, quantity: 100 }], referenceQuote: null },
        exitPlacedAccounts: [],
    }]
    const { opLog, store, restore } = harness(seed)
    try {
        await executionReconciler.handleExecution({ type: 'position.opened', accountId: 'a1', positionId: 'p1', symbol: 'AAPL', direction: 'long', at: 1 })
    } finally { restore() }

    assert.deepEqual(opLog, [
        'db:findOne',            // findLinkedByPosition → null
        'db:findOneAndUpdate',   // backfill positionId
        'capture:captureOpen',
        'db:updateOne',          // claim exit account
        'broker:placeOrder',     // stop
        'broker:placeOrder',     // tp
        'db:updateOne',          // push exitOrders
    ])
    const idea = store.get('idea1')
    assert.equal(idea.brokerOrders[0].positionId, 'p1')       // arrayFilter stamped
    assert.deepEqual(idea.exitPlacedAccounts, ['a1'])
    assert.equal(idea.exitOrders.length, 2)
})

// ── Scenario B: full close → finalize (guarded) → cancel-all bound orders ─────────────────────
test('full close: op sequence + closed state + tracked exits cancelled', async () => {
    const seed = [{
        id: 'idea1', userId: 'u1', asset: 'AAPL', direction: 'long', status: 'long', quantity: 100,
        brokerSymbol: 'AAPL', basisOffset: 0, pendingCloseReason: null,
        brokerOrders: [{ accountId: 'a1', positionId: 'p1', orderId: 'e1', broker: 'ctrader', quantity: 100 }],
        exitOrders: [
            { accountId: 'a1', broker: 'ctrader', leg: 'stop', type: 'stop',  price: 90,  quantity: 100, orderId: 'ord1', status: 'working', positionId: 'p1' },
            { accountId: 'a1', broker: 'ctrader', leg: 'tp',   type: 'limit', price: 110, quantity: 100, orderId: 'ord2', status: 'working', positionId: 'p1' },
        ],
    }]
    // Broker still shows the resting stop working; the tp order that filled is gone.
    const { opLog, store, restore } = harness(seed, { listOrders: [{ orderId: 'ord1', positionId: 'p1' }] })
    try {
        await executionReconciler.handleExecution({ type: 'position.closed', accountId: 'a1', positionId: 'p1', orderId: 'ord2', price: 110, reason: 'tp', pnl: 200, at: 2 })
    } finally { restore() }

    assert.deepEqual(opLog, [
        'db:findOne',            // findActiveByPosition
        'db:findOneAndUpdate',   // finalizeClose (guarded)
        'capture:captureClose',
        'broker:listOrders',     // cancel-all bound orders
        'broker:cancelOrder',    // ord1 still working
        'db:updateOne',          // mirror tracked exits → cancelled
    ])
    const idea = store.get('idea1')
    assert.equal(idea.status, 'closed')
    assert.equal(idea.closedReason, 'tp')
    assert.equal(idea.realizedPnl, 200)
    assert.deepEqual(idea.exitOrders.map(o => o.status), ['cancelled', 'cancelled'])
})

// ── Scenario C: resting stop-entry fill → flip live + stamp positionId → place exits ──────────
test('resting fill: op sequence + resting→long + positionId stamped', async () => {
    const seed = [{
        id: 'idea1', userId: 'u1', asset: 'AAPL', direction: 'long', status: 'resting', quantity: 100,
        brokerSymbol: 'AAPL', basisOffset: 0,
        brokerOrders: [{ accountId: 'a1', positionId: null, orderId: 'e1', broker: 'ctrader', quantity: 100 }],
        nativeExit: { stop: [{ level: 90, quantity: 100 }], tp: [{ level: 110, quantity: 100 }], referenceQuote: null },
        exitPlacedAccounts: [],
    }]
    const { opLog, store, restore } = harness(seed)
    try {
        await executionReconciler.handleExecution({ type: 'order.filled', accountId: 'a1', positionId: 'p1', orderId: 'e1', direction: 'long', at: 3 })
    } finally { restore() }

    assert.deepEqual(opLog, [
        'db:findOneAndUpdate',   // claimRestingFill: resting → long, stamp positionId
        'capture:captureOpen',
        'db:updateOne',          // claim exit account
        'broker:placeOrder',     // stop
        'broker:placeOrder',     // tp
        'db:updateOne',          // push exitOrders
    ])
    const idea = store.get('idea1')
    assert.equal(idea.status, 'long')
    assert.equal(idea.orderState, 'placed')
    assert.equal(idea.brokerOrders[0].positionId, 'p1')
    assert.deepEqual(idea.exitPlacedAccounts, ['a1'])
})

// ── Scenario D: partial reduce (tracked slice) → position survives → resync working exits ─────
test('partial reduce: matched slice filled, broker says still open → resync (no over-close)', async () => {
    const seed = [{
        id: 'idea1', userId: 'u1', asset: 'AAPL', direction: 'long', status: 'long', quantity: 100,
        brokerSymbol: 'AAPL', basisOffset: 0,
        brokerOrders: [{ accountId: 'a1', positionId: 'p1', orderId: 'e1', broker: 'ctrader', quantity: 100 }],
        exitOrders: [
            { accountId: 'a1', broker: 'ctrader', leg: 'tp',   type: 'limit', price: 110, quantity: 40,  orderId: 'ord2', status: 'working', positionId: 'p1' },
            { accountId: 'a1', broker: 'ctrader', leg: 'stop', type: 'stop',  price: 90,  quantity: 100, orderId: 'ord1', status: 'working', positionId: 'p1' },
        ],
    }]
    // Broker reports position still open with 60 remaining after the 40-lot tp fill.
    const { opLog, store, restore } = harness(seed, { findOpenPosition: { volume: 60 } })
    try {
        await executionReconciler.handleExecution({ type: 'position.reduced', accountId: 'a1', positionId: 'p1', orderId: 'ord2', price: 110, pnl: 40, at: 4 })
    } finally { restore() }

    assert.deepEqual(opLog, [
        'db:findOne',            // findActiveByPosition
        'db:updateOne',          // mark matched slice filled (setExitOrders)
        'broker:findOpenPosition', // authoritative survival check
        'broker:cancelOrder',    // resync: shrink the 100-lot stop to 60
        'broker:placeOrder',     // re-place at 60
        'db:updateOne',          // persist resized exitOrders
    ])
    const stop = store.get('idea1').exitOrders.find(o => o.leg === 'stop')
    assert.equal(stop.quantity, 60)   // shrunk to remaining — can't over-close the netting position
})

// ── Scenario E: idealess simulated-venue close → captureClose only, no idea, no broker ────────
test('idealess sim close: captureClose only (no linked idea)', async () => {
    const { opLog, store, restore } = harness([])   // empty store — nothing linked
    try {
        await executionReconciler.handleExecution({ type: 'position.closed', simulated: true, accountId: 'sim1', positionId: 'sp1', price: 5, reason: 'tp', pnl: 10, at: 5 })
    } finally { restore() }

    assert.deepEqual(opLog, [
        'db:findOne',            // findActiveByPosition → null
        'capture:captureClose',  // sim venue still records the close
    ])
})
