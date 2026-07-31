import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeExits, routeSetupZones, zoneExitLevel } from '../../services/protectionPlan.service.js'
import { computeRR } from '../../services/setup.schema.js'

// A confirmed setup used to place a NAKED entry.
//
// `routeExits` read `stop_condition_tree` / `tp_conditions` — the legacy `idea` shape. A setup
// states its exits as ZONES, so both legs came back empty, `exitFields` wrote no `nativeExit`,
// `placeExits` no-opped on `idea.nativeExit === undefined`, and the entry order itself carried no
// stopLoss/takeProfit. The position ran with no stop, no target, and (before Phase 4) no monitor.
//
// These tests are the regression: the failure was silent end-to-end, so nothing caught it.

const SETUP = {
    kind: 'setup', direction: 'long', quantity: 100,
    entry_zones: [{ id: 'ez1', lower: 237.8, upper: 238.6, quantity: 100 }],
    stop_zones:  [{ id: 'sz1', lower: 234.8, upper: 235.9 }],
    tp_zones:    [{ id: 'tp1', lower: 246.0, upper: 247.2 }, { id: 'tp2', lower: 252.0, upper: 253.5 }],
}

test('a setup routes through zones, not through condition trees', async () => {
    // The dispatch lives inside routeExits so the execution path stays kind-blind: it asks one
    // function and gets one shape back, whatever authored the exits.
    const route = await routeExits(SETUP)
    assert.equal(route.stop.hasAny, true, 'a setup with a stop zone must produce a stop order')
    assert.equal(route.tp.hasAny, true)
    assert.equal(route.stop.monitorTree, null, 'a zone IS a price — nothing is left to the software monitor')
})

test('the stop rests at the FAR edge, the target at the NEAR edge', () => {
    const { stop, tp } = routeSetupZones(SETUP)
    assert.equal(stop.nativeOrders[0].level, 234.8, 'far side: the zone gets room to be a zone')
    assert.equal(tp.nativeOrders[0].level, 246.0, 'near side: the first edge price reaches is the one that fills')
})

test('the edges mirror for a short', () => {
    const { stop, tp } = routeSetupZones({ ...SETUP, direction: 'short' })
    assert.equal(stop.nativeOrders[0].level, 235.9)
    assert.equal(tp.nativeOrders[0].level, 247.2)
    assert.equal(zoneExitLevel({ lower: 1, upper: 2 }, false), 2)
})

test('the order prices express the SAME R:R the user was shown', () => {
    // The whole point of picking these edges. If the orders used the flattering side, the plan the
    // user approved and the plan resting at the broker would be different trades.
    const { stop, tp } = routeSetupZones(SETUP)
    const entry = SETUP.entry_zones[0].upper           // computeRR's pessimistic fill for a long
    const rr    = (tp.nativeOrders[0].level - entry) / (entry - stop.nativeOrders[0].level)
    assert.equal(Math.round(rr * 100) / 100, computeRR(SETUP))
})

test('an unset target quantity takes an equal split of what is left', () => {
    const { tp } = routeSetupZones(SETUP)
    assert.deepEqual(tp.nativeOrders.map(o => o.quantity), [50, 50])
})

test('an explicit quantity wins, and the rest share the remainder', () => {
    const { tp } = routeSetupZones({
        ...SETUP,
        tp_zones: [{ lower: 246, upper: 247, quantity: 70 }, { lower: 252, upper: 253 }],
    })
    assert.deepEqual(tp.nativeOrders.map(o => o.quantity), [70, 30])
})

test('a zero-quantity leg is dropped rather than sent to the broker', () => {
    // An order for nothing is a rejected order at best.
    const { tp } = routeSetupZones({
        ...SETUP,
        tp_zones: [{ lower: 246, upper: 247, quantity: 100 }, { lower: 252, upper: 253 }],
    })
    assert.deepEqual(tp.nativeOrders.map(o => o.quantity), [100])
})

test('a setup with no targets still gets its stop', () => {
    // Protection must not depend on the user having named a target.
    const { stop, tp } = routeSetupZones({ ...SETUP, tp_zones: [] })
    assert.equal(stop.nativeOrders.length, 1)
    assert.equal(tp.hasAny, false)
})

test('a malformed zone is skipped, not turned into an order at NaN', () => {
    const { stop } = routeSetupZones({ ...SETUP, stop_zones: [{ id: 'x' }, { lower: 234, upper: 235 }] })
    assert.equal(stop.nativeOrders.length, 1)
    assert.equal(stop.nativeOrders[0].level, 234)
})

test('an idea still routes through its condition trees', async () => {
    // The dispatch must not have stolen the legacy path.
    const route = await routeExits({ kind: 'idea', quantity: 100, stop_conditions: [], tp_conditions: [] })
    assert.equal(route.stop.hasAny, false)
    assert.equal(route.stop.nativeOrders.length, 0)
})
