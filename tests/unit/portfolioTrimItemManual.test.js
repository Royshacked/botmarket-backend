import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _trimItem } from '../../api/portfolio/portfolioRebalance.service.js'

// G7 — a manual-mode trim can't hit a broker, so _trimItem hands back a PARTIAL exit leg (which
// applyRebalance posts as a Fill card) and stamps the trim size on the item so confirmManualExit
// reduces the position even if the FE doesn't forward a quantity.

function fakeDb(item) {
    const updates = []
    return {
        _updates: updates,
        collection: () => ({
            findOne:   async () => item,
            updateOne: async (q, u) => { updates.push({ q, u }) },
        }),
    }
}

const manualItem = (over = {}) => ({
    id: 'i1', userId: 'u1', status: 'long', direction: 'long', asset: 'NVDA', quantity: 10,
    brokerOrders: [{ broker: 'manual', accountId: 'manual-u1', positionId: 'p1', quantity: 10 }],
    ...over,
})

test('manual trim → partial exit leg + stamps pendingTrimQty/pendingCloseReason on the item', async () => {
    const db = fakeDb(manualItem())
    const r  = await _trimItem(db, 'i1', 'u1', { reduceFraction: 0.5 })

    assert.equal(r.ok, true)
    assert.equal(r.manual, true)
    assert.deepEqual(r.manualExitLeg, {
        ideaId: 'i1', asset: 'NVDA', direction: 'long', positionId: 'p1',
        quantity: 5, partial: true, remainingQty: 5,
    })
    // stamped so confirmManualExit can do the partial without the FE forwarding a quantity
    const stamp = db._updates.at(-1).u.$set
    assert.equal(stamp.pendingTrimQty, 5)
    assert.equal(stamp.pendingCloseReason, 'trim')
})

test('manual trim that floors to 0 is rejected (too small)', async () => {
    const db = fakeDb(manualItem({ quantity: 10, brokerOrders: [{ broker: 'manual', positionId: 'p1', quantity: 10 }] }))
    const r  = await _trimItem(db, 'i1', 'u1', { reduceFraction: 0.05 })   // floor(0.5) = 0
    assert.deepEqual(r, { ok: false, reason: 'trim_too_small' })
})

test('a non-manual holding takes the broker path, not the manual branch', async () => {
    // An IBKR leg (capabilities().closePosition === false) is SKIPPED without any broker call —
    // proving it did NOT fall into the manual branch (which would have returned manual:true).
    const db = fakeDb(manualItem({ brokerOrders: [{ broker: 'ibkr', accountId: 'a1', positionId: 'p1', quantity: 10 }] }))
    const r  = await _trimItem(db, 'i1', 'u1', { reduceFraction: 0.5 })
    assert.equal(r.manual, undefined)
    assert.deepEqual(r, { ok: false, legsTrimmed: 0, legsSkipped: 1 })
})

test('bad reduceFraction is rejected before touching the position', async () => {
    const db = fakeDb(manualItem())
    assert.equal((await _trimItem(db, 'i1', 'u1', { reduceFraction: 0 })).reason, 'bad_reduceFraction')
    assert.equal((await _trimItem(db, 'i1', 'u1', { reduceFraction: 1 })).reason, 'bad_reduceFraction')
})
