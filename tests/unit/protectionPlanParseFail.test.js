// What a leg does when the CONDITION PARSER cannot answer.
//
// The outage is INJECTED at monitor.claude's one-shot seam — every model call in this file throws
// the way an unreachable API would. It used to be simulated by blanking ANTHROPIC_API_KEY before a
// lazily-built client read it; the client is the provider's now, built at import, and ESM hoists
// imports above assignments, so that blanking reached nothing (CR on §8).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { touchLeaf, routeExits, detectNativeEntryLevel } from '../../services/protectionPlan.service.js'
import { _setOneShot } from '../../monitoring/monitor.claude.js'

let restore
before(() => { restore = _setOneShot(async () => { throw new Error('Could not resolve authentication method') }) })
after(() => restore())

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
//
// THE SENTENCE UNDER TEST IS NOT touchLeaf's. Since 2026-09-16 `price touches <level>` — the one
// shape the app authors — is parsed by reading it (condition.parser.parseTouchLiteral) and never
// reaches the model, so it cannot fail the way an outage does. These tests used to use exactly that
// sentence and passed only because the key was blank; the outage they simulate is now simulated on
// a touch leaf worded the way a USER might word one, which still goes to the model.
const USER_WORDED = (level) => ({ condition: `price reaches ${level}`, type: 'touch', timeframe: null })

test('an unparseable stop does NOT become a broker order at level 0', async () => {
    const route = await routeExits({
        direction: 'long', quantity: 10,
        stop_conditions: [USER_WORDED(21500)],
        tp_conditions:   [],
    })
    assert.deepEqual(route.stop.nativeOrders, [], 'nothing may rest at the broker from a failed parse')
    assert.notEqual(route.stop.monitorTree, null, 'the leg must fall back to the software monitor')
})

test('the entry trigger is null rather than 0 when the parse fails', async () => {
    // Same value, worse consequence: this one is the trigger price of a stop-market ENTRY.
    const level = await detectNativeEntryLevel({
        entry_conditions: [USER_WORDED(21500)],
        entry_condition_tree: null,
    })
    assert.equal(level, null)
})

test('a leg whose touch rung the parser cannot read keeps the WHOLE leg on the monitor', async () => {
    const route = await routeExits({
        direction: 'long', quantity: 10,
        stop_conditions: [USER_WORDED(21500), { condition: 'RSI(14) below 30', type: 'structured' }],
        tp_conditions:   [],
    })
    assert.deepEqual(route.stop.nativeOrders, [])
    assert.notEqual(route.stop.monitorTree, null)
})

test('the sentence the app writes itself is NOT an outage — it rests at the broker with no model at all', async () => {
    // The contrast that makes the file honest: same unreachable model, the self-authored leaf still routes.
    const route = await routeExits({
        direction: 'long', quantity: 10,
        stop_conditions: [touchLeaf(21500)],
        tp_conditions:   [],
    })
    assert.deepEqual(route.stop.nativeOrders, [{ level: 21500, quantity: 10 }])
    assert.equal(route.stop.monitorTree, null)
})
