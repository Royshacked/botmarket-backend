import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _trimItem } from '../../api/portfolio/portfolioRebalance.service.js'

// THE XLU BUG. A review trim closed half the position at the broker and the app never wrote it down:
// the holding still read 126 shares while 63 were held. That number is not decoration — it is the
// base every later fraction is measured against, so the NEXT "trim half" computed floor(126 × 0.5) =
// 63 and would have closed the whole remaining position.
//
// The reconciler couldn't save us either: it only sizes reductions it can match to a tracked exit
// order, and a review trim places none (see execution.reconciler's own note on untracked partials).
// So the trim writes the reduction itself, and the reconciler re-stamps it from the broker's volume
// when the reduce event lands.

function fakeDb(item) {
    const updates = []
    return {
        _updates: updates,
        collection: () => ({
            findOne:   async () => item,
            // arrayFilters matter as much as the $set here: without them a leg-targeted write hits
            // whichever leg Mongo reaches first.
            updateOne: async (q, u, opts) => { updates.push({ q, u, opts }) },
        }),
    }
}

// A live paper holding, one leg — the shape of the XLU row.
const heldItem = (over = {}) => ({
    id: 'i1', userId: 'u1', status: 'long', direction: 'long', asset: 'XLU', quantity: 126,
    mainAccountId: 'a1',
    brokerOrders: [{ broker: 'paper', accountId: 'a1', positionId: 'p1', quantity: 126 }],
    ...over,
})

const OPEN = async () => ({ deferred: false })

// A broker that can close and records what it was asked to close.
function fakeBroker() {
    const closed = []
    return {
        _closed: closed,
        capabilities: () => ({ closePosition: true, trading: true }),
        closePosition: async (broker, userId, accountId, positionId, opts) => {
            closed.push({ accountId, positionId, quantity: opts?.quantity ?? null })
        },
    }
}

const trim = (db, change, broker = fakeBroker()) => _trimItem(db, 'i1', 'u1', change, OPEN, broker)

const legResizes = updates => updates
    .filter(u => u.u.$set?.['brokerOrders.$[leg].quantity'] != null)
    .map(u => ({ qty: u.u.$set['brokerOrders.$[leg].quantity'], filters: u.opts?.arrayFilters }))

test('a trim writes the reduced size onto the leg it trimmed', async () => {
    const db     = fakeDb(heldItem())
    const broker = fakeBroker()
    const r      = await trim(db, { reduceFraction: 0.5 }, broker)

    assert.equal(r.ok, true)
    assert.deepEqual(broker._closed, [{ accountId: 'a1', positionId: 'p1', quantity: 63 }])

    const resized = legResizes(db._updates)
    assert.equal(resized.length, 1, 'exactly the trimmed leg is resized')
    assert.equal(resized[0].qty, 63, '126 − floor(126 × 0.5)')
    // COMPARE-AND-SET: the filter pins the size this trim measured against. The paper venue emits its
    // reduce synchronously inside closePosition, so the reconciler can already have stamped this leg
    // from the broker's own volume — and that answer must win over our arithmetic, not lose to it.
    assert.deepEqual(resized[0].filters, [{ 'leg.positionId': 'p1', 'leg.quantity': 126 }])
})

test('a refused trim writes nothing — a leg that never moved must not be resized', async () => {
    const db = fakeDb(heldItem({ brokerOrders: [{ broker: 'paper', accountId: 'a1', positionId: 'p1', quantity: 8 }] }))
    const r  = await trim(db, { reduceFraction: 0.05 })   // floor(8 × 0.05) = 0

    assert.equal(r.ok, false)
    assert.equal(r.reason, 'trim_too_small')
    assert.equal(legResizes(db._updates).length, 0)
    assert.equal(db._updates.some(u => u.u.$set?.quantity != null), false)
})

test('quantity is derived from the MAIN account’s legs, summed — a hedging scale-in leaves two', async () => {
    const db = fakeDb(heldItem({
        quantity: 10,
        mainAccountId: 'a1',
        brokerOrders: [
            { broker: 'ctrader', accountId: 'a1', positionId: 'p1', quantity: 10 },
            { broker: 'ctrader', accountId: 'a1', positionId: 'p2', quantity: 3 },   // the scale-in's sibling
            { broker: 'ctrader', accountId: 'a2', positionId: 'p3', quantity: 10 },  // another account, not summed in
        ],
    }))
    const r = await trim(db, { reduceFraction: 0.5 })

    assert.equal(r.ok, true)
    // The fake findOne returns the ORIGINAL item, so this asserts the derivation rule — main account
    // only, its legs summed — rather than the post-trim arithmetic.
    const sync = db._updates.find(u => u.u.$set?.quantity != null)
    assert.ok(sync, 'the trim re-derives the holding quantity')
    assert.equal(sync.u.$set.quantity, 13, 'the main account holds 10 + 3, not 23 across both accounts')
})

test('a leg with no position is not counted into the holding’s size', async () => {
    const db = fakeDb(heldItem({
        brokerOrders: [
            { broker: 'paper', accountId: 'a1', positionId: 'p1', quantity: 126 },
            { broker: 'paper', accountId: 'a1', positionId: null,  quantity: 50 },   // never filled
        ],
    }))
    const r = await trim(db, { reduceFraction: 0.5 })

    assert.equal(r.ok, true)
    const sync = db._updates.find(u => u.u.$set?.quantity != null)
    assert.equal(sync.u.$set.quantity, 126, 'an unfilled leg adds no size')
})
