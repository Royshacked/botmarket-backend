// routeExits splits every stop/TP leg in two: a `touch` leaf is a pure price and rests at the broker
// (nativeOrders); everything else — a structured compare, an indicator, a leaf the parser could not
// read — stays on the software monitor (monitorTree), which exit.monitor evaluates.
//
// This file used to be unwatchedExit.test.js, pinning a guard that logged an ERROR on every
// placement with a residual tree because `checkPosition` had no caller after Minos was deleted.
// exit.monitor.js (b1faf4c) became that caller; the guard kept firing on a false premise and was
// removed. What is worth keeping is the routing contract underneath it.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { routeExits } from '../../services/protectionPlan.service.js'
import { _setOneShot } from '../../monitoring/monitor.claude.js'

// The model is UNREACHABLE for this whole file, injected at monitor.claude's one-shot seam: a
// user-worded parse fails the way an outage would and the leaf falls to the monitor. (Blanking the
// key used to do this; the client is built at import now, so an env assignment reaches nothing.)
let restore
before(() => { restore = _setOneShot(async () => { throw new Error('Could not resolve authentication method') }) })
after(() => restore())

test('a leaf the parser cannot read falls to the monitor, never to a nonsense broker order', async () => {
    const route = await routeExits({
        id: 'e9', asset: 'SPY', direction: 'long', quantity: 10, broker: 'ctrader',
        // Worded the way a USER might, so it needs the model — which this file makes unreachable
        // (see the seam below). touchLeaf's own sentence no longer needs a model; see condition.parser.
        stop_conditions: [{ condition: 'price reaches 400', type: 'touch', timeframe: null }],
        tp_conditions:   [],
    })
    assert.notEqual(route.stop.monitorTree, null, 'the leg is on the monitor')
    assert.deepEqual(route.stop.nativeOrders, [], 'nothing rests at the broker off a failed parse')
    assert.equal(route.stop.hasAny, true)
    assert.equal(route.tp.hasAny, false)
    assert.equal(route.tp.monitorTree, null)
})

test('a SETUP routes through zones: every edge is a price, so nothing is left on the monitor', async () => {
    const route = await routeExits({
        id: 's9', kind: 'setup', asset: 'SPY', direction: 'long', quantity: 100, broker: 'ctrader',
        stop_legs: [{ price: 234.8 }],
        target_legs:   [{ price: 246.0 }],
    })
    assert.equal(route.stop.monitorTree, null)
    assert.equal(route.tp.monitorTree, null)
    assert.equal(route.stop.nativeOrders.length, 1)
    assert.equal(route.tp.nativeOrders.length, 1)
    assert.equal(route.stop.nativeOrders[0].quantity, 100)
})

test('the routing shape is the same whatever authored the exits', async () => {
    const tree = await routeExits({ id: 'i', asset: 'SPY', direction: 'long', quantity: 1, stop_conditions: [], tp_conditions: [] })
    const zone = await routeExits({ id: 's', kind: 'setup', asset: 'SPY', direction: 'long', quantity: 1, stop_legs: [], target_legs: [] })
    for (const r of [tree, zone]) for (const leg of ['stop', 'tp']) {
        assert.deepEqual(Object.keys(r[leg]).sort(), ['hasAny', 'monitorTree', 'nativeOrders'])
        assert.equal(r[leg].hasAny, false)
    }
})
