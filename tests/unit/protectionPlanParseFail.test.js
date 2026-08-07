// What a leg does when the CONDITION PARSER cannot answer.
//
// node --test gives each file its own process, so blanking the key here is isolated — and because
// monitor.claude builds its client lazily (on first call, not at import), setting it before the
// first parse is enough to make every parse in this file fail the way an outage would.
process.env.ANTHROPIC_API_KEY = ''

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { touchLeaf, routeExits, detectNativeEntryLevel } from '../../services/protectionPlan.service.js'

// THE BUG THIS LOCKS. `_leafBareLevel` ended with `const level = Number(parsed.value)` guarded by
// `Number.isFinite(level)`. On a failed parse `parseCondition` catches its own error and returns
// `{ operator: 'unknown', value: null, … }` — and `Number(null)` is 0, which is finite. So the
// guard PASSED and the function reported a price level of ZERO.
//
// Everything downstream believes it. `routeExits` files the leaf under `nativeOrders` — meaning it
// is handled, rest it at the broker — and the residual monitor tree comes back null, so the
// software monitor is told there is nothing left to watch. The stop that should have protected the
// position is a resting order at 0, and the fallback that should have caught it was switched off by
// the same value.
//
// The trigger needs no bug of its own: a missing key, a rate limit, a timeout. parseCondition
// reports all of them as `unknown`, exactly like a sentence nobody could interpret.

test('an unparseable stop does NOT become a broker order at level 0', async () => {
    const route = await routeExits({
        direction: 'long', quantity: 10,
        stop_conditions: [{ condition: 'price touches 21500', type: 'touch', timeframe: null }],
        tp_conditions:   [],
    })
    assert.deepEqual(route.stop.nativeOrders, [], 'nothing may rest at the broker from a failed parse')
    assert.notEqual(route.stop.monitorTree, null, 'the leg must fall back to the software monitor')
})

test('the entry trigger is null rather than 0 when the parse fails', async () => {
    // Same value, worse consequence: this one is the trigger price of a stop-market ENTRY.
    const level = await detectNativeEntryLevel({
        entry_conditions: [touchLeaf(21500)],
        entry_condition_tree: null,
    })
    assert.equal(level, null)
})

test('a leg with several conditions is unaffected — it was never offloadable', async () => {
    const route = await routeExits({
        direction: 'long', quantity: 10,
        stop_conditions: [touchLeaf(21500), { condition: 'RSI(14) below 30', type: 'structured' }],
        tp_conditions:   [],
    })
    assert.deepEqual(route.stop.nativeOrders, [])
    assert.notEqual(route.stop.monitorTree, null)
})
