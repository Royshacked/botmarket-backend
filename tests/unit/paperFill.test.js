import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTriggered, selectFills } from '../../monitoring/paperFill.service.js'

// Resting paper orders fill on the first sweep where the latest sampled price (Yahoo
// last quote / candle-close fallback) has crossed the level — a touch approximation of
// a real resting broker order. `price` is a single scalar (not a candle high/low).

test('long TP (short limit): fills when price reaches 432', () => {
    const tp = { type: 'limit', direction: 'short', triggerPrice: 432 }
    assert.equal(isTriggered(tp, 432.1), true,  'price reached 432 → fill')
    assert.equal(isTriggered(tp, 431.9), false, 'price below 432 → no fill')
})

test('long SL (short stop): fills when price breaks the stop', () => {
    const sl = { type: 'stop', direction: 'short', triggerPrice: 420 }
    assert.equal(isTriggered(sl, 419.5), true,  'price pierced 420 → fill')
    assert.equal(isTriggered(sl, 421),   false, 'price held above 420 → no fill')
})

test('long entry stop (long stop): fills on breakout', () => {
    const entry = { type: 'stop', direction: 'long', triggerPrice: 440 }
    assert.equal(isTriggered(entry, 440.2), true)
    assert.equal(isTriggered(entry, 439.5), false)
})

test('long entry limit (long limit): fills on a dip', () => {
    const entry = { type: 'limit', direction: 'long', triggerPrice: 430 }
    assert.equal(isTriggered(entry, 429.8), true)
    assert.equal(isTriggered(entry, 430.5), false)
})

test('guards: null price / null trigger → not triggered', () => {
    const tp = { type: 'limit', direction: 'short', triggerPrice: 432 }
    assert.equal(isTriggered(tp, null), false)
    assert.equal(isTriggered({ type: 'limit', direction: 'short', triggerPrice: null }, 500), false)
})

// selectFills: when a position's stop AND take-profit both trigger in one sweep, an
// intrabar touch feed can't order them — assume the ADVERSE stop filled first and drop
// that position's TP, so the sim doesn't always book the favorable exit.
const sl = (positionId) => ({ orderId: `sl-${positionId}`, positionId, type: 'stop' })
const tp = (positionId) => ({ orderId: `tp-${positionId}`, positionId, type: 'limit' })

test('selectFills: stop + TP for same position → keep stop, drop TP', () => {
    const kept = selectFills([tp(1), sl(1)])
    assert.deepEqual(kept.map(o => o.orderId), ['sl-1'], 'only the stop survives')
})

test('selectFills: TP alone (no stop triggered) → keep it', () => {
    const kept = selectFills([tp(1)])
    assert.deepEqual(kept.map(o => o.orderId), ['tp-1'])
})

test('selectFills: conflict is per-position — other positions untouched', () => {
    const kept = selectFills([tp(1), sl(1), tp(2)])
    assert.deepEqual(kept.map(o => o.orderId).sort(), ['sl-1', 'tp-2'], 'pos 2 TP kept, pos 1 TP dropped')
})

test('selectFills: entries (no positionId) always pass through', () => {
    const entry = { orderId: 'entry', positionId: null, type: 'stop' }
    const kept  = selectFills([entry, tp(1), sl(1)])
    assert.deepEqual(kept.map(o => o.orderId).sort(), ['entry', 'sl-1'])
})
