import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blendPosition, addToPaperPosition } from '../../api/broker/paperExecution.service.js'

// Adding to a holding used to open a SECOND paper position, so a book showed "MU 10 @ 987" and
// "MU 3 @ 1018" as two holdings of the same name — neither of them the 13 shares the user owns. A
// netting venue reports one position at a blended price, and that is the honest picture of one
// holding, so the simulation imitates it. Manual already did (addToManualPosition); paper was the
// outlier, and both now share this blend.

test('the blend is SIZE-weighted — the plain mean is the wrong answer', () => {
    // The MU numbers, exactly: 10 @ 987.2367 + 3 @ 1018.4118.
    const r = blendPosition({ qty: 10, avgPrice: 987.2367, addQty: 3, addPrice: 1018.4118 })
    assert.equal(r.qty, 13)
    assert.equal(r.avgPrice, 994.43095385)
    // What an unweighted mean would have said — 1002.82, the number the two unfolded rows implied.
    assert.notEqual(Number(r.avgPrice.toFixed(2)), Number(((987.2367 + 1018.4118) / 2).toFixed(2)))
})

// Not cents. openPosition stores an unrounded entry, so a 2dp blend would make a scale-in coarser
// than the entry it blends into — and on a sub-cent instrument it rounds the cost basis to zero.
test('the blended price keeps sub-cent precision', () => {
    const r = blendPosition({ qty: 1000, avgPrice: 0.000012, addQty: 1000, addPrice: 0.000018 })
    assert.equal(r.avgPrice, 0.000015)
})

test('a blend at the same price leaves the average alone', () => {
    assert.deepEqual(blendPosition({ qty: 10, avgPrice: 50, addQty: 5, addPrice: 50 }), { qty: 15, avgPrice: 50 })
})

test('doubling the size moves the average exactly halfway', () => {
    assert.deepEqual(blendPosition({ qty: 10, avgPrice: 100, addQty: 10, addPrice: 120 }), { qty: 20, avgPrice: 110 })
})

test('fractional sizes survive the blend (crypto, and any non-integer lot)', () => {
    const r = blendPosition({ qty: 0.5, avgPrice: 60000, addQty: 0.25, addPrice: 66000 })
    assert.equal(r.qty, 0.75)
    assert.equal(r.avgPrice, 62000)
})

// ── The paper venue's scale-in ────────────────────────────────────────────────────────────────────

// A store the assertions can read back, in the shape paperBrokerService presents.
function fakeStore(pos, settings = { spreadBps: 0, commissionPerTrade: 0 }) {
    const updates = [], balances = []
    return {
        _updates: updates,
        _balances: balances,
        getPosition:   async () => pos,
        getAccount:    async () => ({ accountId: pos?.accountId, currency: 'USD', settings }),
        updatePosition: async (userId, positionId, fields) => { updates.push({ positionId, fields }) },
        adjustBalance:  async (userId, accountId, delta) => { balances.push(delta) },
    }
}

const openPos = (over = {}) => ({
    userId: 'u1', accountId: 'paper-u1-x', positionId: 'p1',
    symbol: 'MU', direction: 'long', qty: 10, avgPrice: 987.2367, status: 'open', ...over,
})

const noEmit = { emit: () => {} }

test('the scale-in grows the SAME position — it never inserts a second one', async () => {
    const store = fakeStore(openPos())
    const r = await addToPaperPosition(
        { userId: 'u1', positionId: 'p1', addQty: 3, price: 1018.4118 },
        { store, bus: noEmit },
    )

    assert.equal(r.positionId, 'p1', 'the position it was asked to grow, echoed back')
    assert.equal(r.qty, 13)
    assert.equal(r.avgPrice, 994.43095385)
    assert.equal(r.addedQty, 3)
    // One write, to the one position.
    assert.equal(store._updates.length, 1)
    assert.deepEqual(store._updates[0], { positionId: 'p1', fields: { qty: 13, avgPrice: 994.43095385 } })
})

test('the added slice crosses the spread, like any other entry', async () => {
    const store = fakeStore(openPos({ qty: 10, avgPrice: 100 }), { spreadBps: 100, commissionPerTrade: 0 })
    // A long buys at the ask: 100 + (100 × 1%)/2 = 100.5 on the added slice.
    const r = await addToPaperPosition({ userId: 'u1', positionId: 'p1', addQty: 10, price: 100 }, { store, bus: noEmit })

    assert.equal(r.fillPrice, 100.5, 'the slice paid the ask')
    assert.equal(r.avgPrice, 100.25, '(100×10 + 100.5×10) / 20')
})

test('a short scales in on the bid side', async () => {
    const store = fakeStore(openPos({ direction: 'short', qty: 10, avgPrice: 100 }), { spreadBps: 100, commissionPerTrade: 0 })
    const r = await addToPaperPosition({ userId: 'u1', positionId: 'p1', addQty: 10, price: 100 }, { store, bus: noEmit })

    assert.equal(r.fillPrice, 99.5, 'a short sells at the bid')
})

test('the slice’s commission is banked as a realized cost, not folded into the average', async () => {
    const store = fakeStore(openPos({ qty: 10, avgPrice: 100 }), { spreadBps: 0, commissionPerTrade: 1.5 })
    const r = await addToPaperPosition({ userId: 'u1', positionId: 'p1', addQty: 10, price: 100 }, { store, bus: noEmit })

    assert.equal(r.avgPrice, 100, 'commission is cash, not cost basis')
    assert.deepEqual(store._balances, [{ cash: -1.5, realizedPnl: -1.5 }])
})

test('the fill event names the EXISTING position and the added slice — the shape the reconciler reads as a scale-in', async () => {
    const store  = fakeStore(openPos())
    const events = []
    await addToPaperPosition(
        { userId: 'u1', positionId: 'p1', addQty: 3, price: 1018.4118, orderId: 'ord-1' },
        { store, bus: { emit: (name, e) => events.push({ name, e }) } },
    )
    // The emit is deferred (setImmediate) so a synchronous caller finishes stamping first.
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(events.length, 1)
    const { name, e } = events[0]
    assert.equal(name, 'execution')
    assert.equal(e.type, 'position.opened')
    assert.equal(e.positionId, 'p1', 'the position that grew, not a new id')
    assert.equal(e.quantity, 3, 'the slice, not the new total — captureOpen sizes the trade from it')
    assert.equal(e.orderId, 'ord-1')
})

test('a position that is gone is refused, never re-opened', async () => {
    for (const gone of [null, { ...openPos(), status: 'closed' }]) {
        const store = fakeStore(gone)
        const r = await addToPaperPosition({ userId: 'u1', positionId: 'p1', addQty: 3, price: 100 }, { store, bus: noEmit })
        assert.equal(r, null)
        assert.equal(store._updates.length, 0)
    }
})

test('a non-positive size or price throws rather than silently corrupting the basis', async () => {
    const store = fakeStore(openPos())
    for (const bad of [{ addQty: 0 }, { addQty: -3 }, { price: 0 }, { price: -5 }]) {
        await assert.rejects(() => addToPaperPosition(
            { userId: 'u1', positionId: 'p1', addQty: 3, price: 100, ...bad },
            { store, bus: noEmit },
        ))
    }
    assert.equal(store._updates.length, 0)
})
