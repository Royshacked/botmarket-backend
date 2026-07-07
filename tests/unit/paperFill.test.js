import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTriggered, selectFills } from '../../monitoring/paperFill.service.js'

// Resting paper orders must fill on an intra-bar TOUCH (candle high/low crossing the
// level), not only when a candle closes beyond it — so a limit/stop behaves like a
// real resting broker order. quote = { c, h, l } from the latest 1-min candle.

const q = (h, l, c = (h + l) / 2) => ({ h, l, c })

test('long TP (short limit): fills when the high touches 432 even if it closes below', () => {
    const tp = { type: 'limit', direction: 'short', triggerPrice: 432 }
    assert.equal(isTriggered(tp, q(432.1, 430, 431.2)), true,  'high reached 432 → fill')
    assert.equal(isTriggered(tp, q(431.9, 430, 431.5)), false, 'high never reached 432 → no fill')
})

test('long SL (short stop): fills when the low breaks the stop', () => {
    const sl = { type: 'stop', direction: 'short', triggerPrice: 420 }
    assert.equal(isTriggered(sl, q(425, 419.5)), true,  'low pierced 420 → fill')
    assert.equal(isTriggered(sl, q(425, 421)),   false, 'low held above 420 → no fill')
})

test('long entry stop (long stop): fills on breakout high', () => {
    const entry = { type: 'stop', direction: 'long', triggerPrice: 440 }
    assert.equal(isTriggered(entry, q(440.2, 438)), true)
    assert.equal(isTriggered(entry, q(439.5, 438)), false)
})

test('long entry limit (long limit): fills on a dip low', () => {
    const entry = { type: 'limit', direction: 'long', triggerPrice: 430 }
    assert.equal(isTriggered(entry, q(432, 429.8)), true)
    assert.equal(isTriggered(entry, q(432, 430.5)), false)
})

test('guards: null quote / null trigger / missing h,l → not triggered', () => {
    const tp = { type: 'limit', direction: 'short', triggerPrice: 432 }
    assert.equal(isTriggered(tp, null), false)
    assert.equal(isTriggered({ type: 'limit', direction: 'short', triggerPrice: null }, q(500, 400)), false)
    assert.equal(isTriggered(tp, { c: 432, h: null, l: null }), false)
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
