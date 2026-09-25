import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeExits, routeSetupLegs } from '../../services/protectionPlan.service.js'
import { computeRR, projectScenario, legPrice } from '../../services/setup.schema.js'

// A confirmed setup used to place a NAKED entry.
//
// `routeExits` read `stop_condition_tree` / `tp_conditions` — the legacy `idea` shape. A setup
// states its exits as PRICED LEGS, so both legs came back empty, `exitFields` wrote no `nativeExit`,
// `placeExits` no-opped on `idea.nativeExit === undefined`, and the entry order itself carried no
// stopLoss/takeProfit. The position ran with no stop, no target, and (before Phase 4) no monitor.
//
// These tests are the regression: the failure was silent end-to-end, so nothing caught it.

const SETUP = {
    kind: 'setup', direction: 'long', quantity: 100,
    entry_legs: [{ id: 'ez1', price: 238.6, quantity: 100 }],
    stop_legs:  [{ id: 'sz1', price: 234.8 }],
    target_legs:    [{ id: 'tp1', price: 246.0 }, { id: 'tp2', price: 252.0 }],
}

// The Phase-6 half of the same guarantee: exits are routed off the flat zones, and those are the
// EXECUTION PROJECTION of whichever scenario armed. If Talos ever stopped stamping it, a rival
// premise's stop would rest behind the position that actually opened — silently, exactly like the
// naked-entry bug above.
test('the exits belong to the premise that armed, not to the first one authored', () => {
    const RIVALS = {
        kind: 'setup', direction: 'long',
        scenarios: [
            { id: 's1', entry_legs: [{ price: 238.6, quantity: 100 }],
              stop_legs: [{ price: 234.8 }], target_legs: [{ price: 246 }], quantity: 100 },
            { id: 's2', entry_legs: [{ price: 244.9, quantity: 60 }],
              stop_legs: [{ price: 241.8 }], target_legs: [{ price: 252 }], quantity: 60 },
        ],
    }
    const armed = { ...RIVALS, ...projectScenario(RIVALS, 's2') }
    const { stop, tp } = routeSetupLegs(armed)
    assert.equal(stop.nativeOrders[0].level, 241.8, "s2's stop, not s1's 234.8")
    assert.equal(tp.nativeOrders[0].level, 252, "s2's target, at the level the user named")
    assert.equal(stop.nativeOrders[0].quantity, 60, 'and s2\'s size — never 160')
})

test('a setup routes through its legs, not through condition trees', async () => {
    // The dispatch lives inside routeExits so the execution path stays kind-blind: it asks one
    // function and gets one shape back, whatever authored the exits.
    const route = await routeExits(SETUP)
    assert.equal(route.stop.hasAny, true, 'a setup with a stop must produce a stop order')
    assert.equal(route.tp.hasAny, true)
    assert.equal(route.stop.monitorTree, null, 'a leg IS a price — nothing is left to the software monitor')
})

test('EVERY LEG RESTS AT THE PRICE THE USER NAMED', () => {
    // This used to be "both legs rest at the edge FURTHER FROM ENTRY", and it was the single most
    // expensive consequence of the band shape: a stop the user put at 234.8, widened to 234.8–235.9,
    // rested at 234.8 on a long and at 235.9 on a short — the same sentence, two different amounts
    // of money, decided by a field the user never saw. One price per leg, so the order IS the plan.
    const { stop, tp } = routeSetupLegs(SETUP)
    assert.equal(stop.nativeOrders[0].level, 234.8)
    assert.equal(tp.nativeOrders[0].level, 246.0, 'the TP the user named')
})

test('and DIRECTION no longer moves a level', () => {
    const long  = routeSetupLegs(SETUP)
    const short = routeSetupLegs({ ...SETUP, direction: 'short' })
    assert.equal(short.stop.nativeOrders[0].level, long.stop.nativeOrders[0].level, 234.8)
    assert.equal(short.tp.nativeOrders[0].level,   long.tp.nativeOrders[0].level)
})

test('legPrice is the ONE rule, and it no longer asks direction or leg type', () => {
    // It was `zoneLevel(zone, isLong, which)`: long → stop at `lower`, tp at `upper`, entry at
    // `upper`. Three callers had to agree on those arguments, and disagreeing meant a prompt naming
    // one price while the broker rested another.
    assert.equal(legPrice({ price: 246 }), 246)
    assert.equal(legPrice({ price: 'abc' }), null, 'junk is nothing, never NaN at a broker')
    assert.equal(legPrice({}), null)
    assert.equal(legPrice(null), null)
    assert.equal(legPrice({ lower: 246, upper: 246 }), null, 'the band shape is read nowhere')
})

test('THE RESTING ORDERS ARE THE R:R THE USER WAS SHOWN — exactly, again', () => {
    // It asserted equality once, then could not: a band made `computeRR` read a target's near edge
    // (so the advertised number could never flatter) while the limit rested at the far one, and the
    // test was weakened to "the resting plan is never WORSE than the advertised one". With one price
    // per leg the two are the same number by construction, so the strong assertion comes back.
    //
    // Keep it strong. The weak form passes a plan that quietly rests a better trade than it sold —
    // pleasant, and still a plan that is not the one on the card.
    const { stop, tp } = routeSetupLegs(SETUP)
    const entry   = SETUP.entry_legs[0].price
    const resting = (tp.nativeOrders[0].level - entry) / (entry - stop.nativeOrders[0].level)
    assert.equal(Math.round(resting * 100) / 100, computeRR(SETUP))
})

test('an unset target quantity takes an equal split of what is left', () => {
    const { tp } = routeSetupLegs(SETUP)
    assert.deepEqual(tp.nativeOrders.map(o => o.quantity), [50, 50])
})

test('an explicit quantity wins, and the rest share the remainder', () => {
    const { tp } = routeSetupLegs({
        ...SETUP,
        target_legs: [{ price: 246, quantity: 70 }, { price: 252 }],
    })
    assert.deepEqual(tp.nativeOrders.map(o => o.quantity), [70, 30])
})

test('a zero-quantity leg is dropped rather than sent to the broker', () => {
    // An order for nothing is a rejected order at best.
    const { tp } = routeSetupLegs({
        ...SETUP,
        target_legs: [{ price: 246, quantity: 100 }, { price: 252 }],
    })
    assert.deepEqual(tp.nativeOrders.map(o => o.quantity), [100])
})

test('a setup with no targets still gets its stop', () => {
    // Protection must not depend on the user having named a target.
    const { stop, tp } = routeSetupLegs({ ...SETUP, target_legs: [] })
    assert.equal(stop.nativeOrders.length, 1)
    assert.equal(tp.hasAny, false)
})

test('a malformed zone is skipped, not turned into an order at NaN', () => {
    const { stop } = routeSetupLegs({ ...SETUP, stop_legs: [{ id: 'x' }, { price: 234 }] })
    assert.equal(stop.nativeOrders.length, 1)
    assert.equal(stop.nativeOrders[0].level, 234)
})

test('an idea still routes through its condition trees', async () => {
    // The dispatch must not have stolen the legacy path.
    const route = await routeExits({ kind: 'idea', quantity: 100, stop_conditions: [], tp_conditions: [] })
    assert.equal(route.stop.hasAny, false)
    assert.equal(route.stop.nativeOrders.length, 0)
})

// ── Conditional legs: the two rules that point in opposite directions ─────────
//
// docs/desks/mentor-talos.md, "the exit asymmetry". A condition on an exit is a SENTENCE the model
// judges on its next read — the same thing an entry condition is. What differs is what happens
// while nobody is reading it, and the answer is not the same for the two legs.

test('a CONDITIONAL STOP still rests at the broker — the floor a condition may not remove', () => {
    // Talos proposes and never fires. A conditional stop that was the only protection would leave a
    // live position naked whenever the model is late, the process is down, the market gaps, or the
    // user is simply asleep. The condition may TIGHTEN the exit; it may never replace it.
    const conditional = {
        ...SETUP,
        stop_legs: [{ id: 'sz1', price: 234,
                       conditions: [{ id: 'sc1', text: 'out early if it closes below the 4hr VWAP' }] }],
    }
    const { stop } = routeSetupLegs(conditional)
    assert.equal(stop.hasAny, true, 'a conditional stop MUST still produce a resting order')
    assert.equal(stop.nativeOrders[0].level, 234)
    assert.equal(stop.nativeOrders[0].quantity, 100)
    assert.equal(stop.monitorTree, null, 'and no tree — nothing here evaluates a sentence')
})

test('a CONDITIONAL TARGET does NOT rest, or its own limit would make the condition dead letter', () => {
    // "Take 330 only if volume confirms" resting as a plain limit takes 330 on no volume at all.
    // The safe failure for a target is NOT exiting, so it waits for the model. The stop still holds
    // the position either way, which is what makes this the cheaper mistake.
    const mixed = {
        ...SETUP,
        target_legs: [{ id: 'tp1', price: 246 },
                   { id: 'tp2', price: 252,
                     conditions: [{ id: 'tc1', text: 'only if volume confirms the push' }] }],
    }
    const { tp } = routeSetupLegs(mixed)
    assert.deepEqual(tp.nativeOrders.map(o => o.level), [246], 'only the unconditional target rests')
    // …and the conditional one keeps its share of the size rather than handing it to the other leg.
    assert.equal(tp.nativeOrders[0].quantity, 50, 'the held-back leg still owns its 50')
})

test('a setup whose targets are ALL conditional rests nothing, and says so', () => {
    const allConditional = {
        ...SETUP,
        target_legs: [{ id: 'tp1', price: 246, conditions: [{ id: 'tc1', text: 'if momentum holds' }] }],
    }
    const { stop, tp } = routeSetupLegs(allConditional)
    assert.equal(tp.hasAny, false, 'nothing for the broker to hold')
    assert.deepEqual(tp.nativeOrders, [])
    assert.equal(stop.hasAny, true, 'but the stop is still resting — that is the whole point')
})
