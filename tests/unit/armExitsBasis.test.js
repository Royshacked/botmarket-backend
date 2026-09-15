import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { armExitsInPosition } from '../../api/trade-ideas/exitOrders.service.js'
import { brokerService } from '../../api/broker/broker.service.js'

// Editing a stop or target WHILE IN POSITION re-arms it through armExitsInPosition. That path built
// its closing order inline with the RAW authored level, while the placement path (reconciler →
// buildExitOrder) shifts the level by the idea's fork-measured basisOffset. On a cTrader index CFD
// the same stop therefore rested at two different prices depending on when it was set — ~227 pts
// apart on NQ/US100. Both paths now go through buildExitOrder.

const real = { placeOrder: brokerService.placeOrder, cancelOrder: brokerService.cancelOrder }
afterEach(() => Object.assign(brokerService, real))

function spy() {
    const placed = [], cancelled = []
    brokerService.placeOrder  = async (broker, userId, acct, order) => { placed.push(order); return { orderId: `o${placed.length}` } }
    brokerService.cancelOrder = async (broker, userId, acct, orderId) => { cancelled.push(orderId) }
    return { placed, cancelled }
}

const IDEA = {
    id: 'i1', userId: 'u1', asset: 'NQ', brokerSymbol: 'US100', direction: 'long', quantity: 2,
    basisOffset: -227.5,
    brokerOrders: [{ broker: 'ctrader', accountId: 'a1', positionId: 'p1', quantity: 2 }],
    exitOrders:   [{ leg: 'stop', status: 'working', orderId: 'old1', accountId: 'a1', broker: 'ctrader', price: 19900 }],
}
const ROUTE = {
    stop: { nativeOrders: [{ level: 19950, quantity: 2 }] },
    tp:   { nativeOrders: [{ level: 20400, quantity: 1 }, { level: 20600, quantity: 1 }] },
}

test('the broker order carries the SHIFTED level; the record keeps the AUTHORED one', async () => {
    const { placed, cancelled } = spy()
    const { exitOrders } = await armExitsInPosition(IDEA, ROUTE)

    assert.deepEqual(cancelled, ['old1'], 'the prior working exit is cancelled first')
    const stop = placed.find(o => o.type === 'stop')
    assert.equal(stop.stopPrice, 19722.5, '19950 + (−227.5)')
    assert.equal(stop.direction, 'short', 'a closing order is the opposite side')
    assert.equal(stop.symbol, 'US100')
    assert.equal(stop.positionId, 'p1')
    assert.deepEqual(placed.filter(o => o.type === 'limit').map(o => o.limitPrice), [20172.5, 20372.5])

    const recorded = exitOrders.filter(o => o.status === 'working')
    assert.deepEqual(recorded.map(o => o.price), [19950, 20400, 20600], 'records are in authored space')
    assert.equal(exitOrders.find(o => o.orderId === 'old1').status, 'cancelled')
})

test('no basisOffset → identity, so every non-index instrument is untouched', async () => {
    const { placed } = spy()
    await armExitsInPosition({ ...IDEA, asset: 'AAPL', brokerSymbol: 'AAPL', basisOffset: 0 }, ROUTE)
    assert.equal(placed.find(o => o.type === 'stop').stopPrice, 19950)
})

test('per-account quantities scale by the leg\'s share and drop zero rungs', async () => {
    const { placed } = spy()
    const idea = { ...IDEA, quantity: 4, brokerOrders: [{ broker: 'ctrader', accountId: 'a1', positionId: 'p1', quantity: 2 }] }
    await armExitsInPosition(idea, { stop: { nativeOrders: [{ level: 19950, quantity: 4 }] }, tp: { nativeOrders: [{ level: 20400, quantity: 0 }] } })
    assert.equal(placed.length, 1, 'the zero-quantity target is not sent')
    assert.equal(placed[0].quantity, 2, 'half the idea on an account holding half of it')
})
