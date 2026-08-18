// The guard over a promise the app currently cannot keep.
//
// `positionMonitor.checkPosition` — the only code that evaluates a stop/TP condition tree for an
// entity already in a position — has NO CALLER. Minos was its only one and Minos was deleted
// (2026-08-18). `routeExits` still routes non-touch leaves to it on every placement, so a stop that
// is not a plain price level is accepted, stored, and displayed as protection while nothing ever
// looks at it. `unmonitoredExitLegs` names exactly those legs so the placement path can say so out
// loud instead of failing silently.
//
// These tests are the contract for WHICH legs count — the part that must not drift while the real
// exit loop is being built, and the part that tells you when the guard can be deleted.
process.env.ANTHROPIC_API_KEY = ''   // parses fail → every leaf falls to the monitor, like an outage

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeExits, unmonitoredExitLegs, touchLeaf } from '../../services/protectionPlan.service.js'

const NATIVE_LEG = { single: null, nativeOrders: [{ level: 100, quantity: 10 }], monitorTree: null, hasAny: true }
const EMPTY_LEG  = { single: null, nativeOrders: [], monitorTree: null, hasAny: false }
const RESIDUAL   = { single: null, nativeOrders: [], hasAny: true,
                     monitorTree: { operator: 'OR', children: [{ condition: 'RSI(14) below 30', quantity: 10 }] } }

test('a residual monitor tree is an unwatched leg', () => {
    const legs = unmonitoredExitLegs({ id: 'e1', asset: 'SPY', broker: 'ctrader' }, { stop: RESIDUAL, tp: NATIVE_LEG })
    assert.deepEqual(legs, [{ leg: 'stop', why: 'residual' }])
})

test('both legs can be unwatched at once', () => {
    const legs = unmonitoredExitLegs({ id: 'e1', broker: 'ctrader' }, { stop: RESIDUAL, tp: RESIDUAL })
    assert.deepEqual(legs.map(l => l.leg), ['stop', 'tp'])
})

test('an all-touch routing is watched by the BROKER, so it is not a hole', () => {
    // The whole point of the touch/non-touch split: a resting order protects a position nobody is
    // polling. This must stay silent, or the guard cries on every ordinary placement.
    assert.deepEqual(unmonitoredExitLegs({ id: 'e1', broker: 'ctrader' }, { stop: NATIVE_LEG, tp: NATIVE_LEG }), [])
})

test('a leg with no exits at all is not a hole', () => {
    assert.deepEqual(unmonitoredExitLegs({ id: 'e1', broker: 'paper' }, { stop: EMPTY_LEG, tp: EMPTY_LEG }), [])
})

test('MANUAL: even a pure touch leg is unwatched — there is no venue to rest it at', () => {
    // `confirmManualEntry` writes `monitorStop: hasAny` and no residual tree, so the monitor owns
    // the WHOLE leg. Reading only `monitorTree` here would have missed manual mode entirely.
    const legs = unmonitoredExitLegs({ id: 'm1', broker: 'manual' }, { stop: NATIVE_LEG, tp: EMPTY_LEG })
    assert.deepEqual(legs, [{ leg: 'stop', why: 'manual' }])
})

test('a manual PORTFOLIO leg is monitor-less on purpose — never flagged', () => {
    // manual-mode §4b: a portfolio exit is the user's act. `manualIdea.service` switches the
    // monitor off for these deliberately, so warning about them would be noise that trains you to
    // ignore the real ones.
    const holding = { id: 'm2', broker: 'manual', portfolioId: 'portfolio_1' }
    assert.deepEqual(unmonitoredExitLegs(holding, { stop: NATIVE_LEG, tp: NATIVE_LEG }), [])
})

test('a manual leg that ALSO has a residual tree reports the residual reason', () => {
    const legs = unmonitoredExitLegs({ id: 'm3', broker: 'manual' }, { stop: RESIDUAL, tp: EMPTY_LEG })
    assert.deepEqual(legs, [{ leg: 'stop', why: 'residual' }])
})

test('a bare/absent routing never throws — the guard must not break a placement', () => {
    assert.deepEqual(unmonitoredExitLegs(null, null), [])
    assert.deepEqual(unmonitoredExitLegs({}, { stop: null }), [])
})

// ─── through routeExits ──────────────────────────────────────────────────────
// The guard wraps a `return`, so the risk it introduces is the routing itself.

test('routeExits still returns its routing untouched while warning', async () => {
    const route = await routeExits({
        id: 'e9', asset: 'SPY', direction: 'long', quantity: 10, broker: 'ctrader',
        stop_conditions: [touchLeaf(400)],   // unparseable here (blank key) → falls to the monitor
        tp_conditions:   [],
    })
    assert.notEqual(route.stop.monitorTree, null, 'the leg is on the monitor')
    assert.deepEqual(route.stop.nativeOrders, [])
    assert.equal(route.tp.hasAny, false)
    assert.deepEqual(unmonitoredExitLegs({ broker: 'ctrader' }, route), [{ leg: 'stop', why: 'residual' }])
})

test('a SETUP routes through zones and is never flagged — its exits rest at the broker', async () => {
    const route = await routeExits({
        id: 's9', kind: 'setup', asset: 'SPY', direction: 'long', quantity: 100, broker: 'ctrader',
        stop_zones: [{ lower: 234.8, upper: 235.9 }],
        tp_zones:   [{ lower: 246.0, upper: 247.2 }],
    })
    assert.equal(route.stop.monitorTree, null)
    assert.deepEqual(unmonitoredExitLegs({ kind: 'setup', broker: 'ctrader' }, route), [])
})
