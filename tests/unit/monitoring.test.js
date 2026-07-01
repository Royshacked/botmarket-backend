import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candleMs, parseYesNo, round } from '../../monitoring/monitorUtils.js'
import { parseIndicators } from '../../monitoring/parsers/indicators.parser.js'
import { buildExitOrder, exitOrderRecord, closeSide, orderSymbol } from '../../monitoring/exitOrders.util.js'

test('candleMs: seconds are scaled to ms, ms pass through', () => {
    assert.equal(candleMs(1_600_000_000),     1_600_000_000_000)   // < 1e12 → seconds
    assert.equal(candleMs(1_600_000_000_000), 1_600_000_000_000)   // already ms
})

test('parseYesNo: leading-Y is a yes (lenient, shared by LLM evaluators)', () => {
    assert.equal(parseYesNo('YES'),  true)
    assert.equal(parseYesNo('Yes.'), true)
    assert.equal(parseYesNo(' y '),  true)
    assert.equal(parseYesNo('no'),   false)
    assert.equal(parseYesNo(''),     false)
    assert.equal(parseYesNo(null),   false)
})

test('round: 4-decimal rounding, non-numeric → 0', () => {
    assert.equal(round(1.234567), 1.2346)
    assert.equal(round('nope'), 0)
})

test('parseIndicators: extracts family(period) pairs in order', () => {
    assert.deepEqual(
        parseIndicators('rsi(14) and ema(50) then sma(200)'),
        [{ family: 'rsi', period: 14 }, { family: 'ema', period: 50 }, { family: 'sma', period: 200 }],
    )
})

test('closeSide: opposite of the position direction', () => {
    assert.equal(closeSide('long'),  'short')
    assert.equal(closeSide('short'), 'long')
})

test('orderSymbol: broker alias wins, falls back to asset', () => {
    assert.equal(orderSymbol({ brokerSymbol: 'US100', asset: 'NQ' }), 'US100')
    assert.equal(orderSymbol({ asset: 'AAPL' }), 'AAPL')
})

test('buildExitOrder: closing order flips direction, stamps positionId', () => {
    const idea = { direction: 'long', asset: 'AAPL', brokerSymbol: 'US100' }
    assert.deepEqual(
        buildExitOrder(idea, { type: 'market', qty: 1, positionId: 'p1' }),
        { symbol: 'US100', direction: 'short', quantity: 1, type: 'market', positionId: 'p1' },
    )
})

test('buildExitOrder: tp → limit at level, stop → stop at level', () => {
    const idea = { direction: 'short', asset: 'AAPL' }
    const tp = buildExitOrder(idea, { type: 'tp', level: 100, qty: 2 })
    assert.equal(tp.type, 'limit')
    assert.equal(tp.direction, 'long')     // closing a short
    assert.equal(tp.limitPrice, 100)

    const stop = buildExitOrder(idea, { type: 'stop', level: 120, qty: 2 })
    assert.equal(stop.type, 'stop')
    assert.equal(stop.stopPrice, 120)
})

test('exitOrderRecord: working record with placedAt and null-coalesced positionId', () => {
    const rec = exitOrderRecord({
        accountId: 'a1', broker: 'paper', leg: 'tp', type: 'limit',
        price: 100, quantity: 1, positionId: null, orderId: 'o1',
    })
    assert.equal(rec.status, 'working')
    assert.equal(rec.positionId, null)
    assert.equal(rec.orderId, 'o1')
    assert.equal(typeof rec.placedAt, 'number')
})
