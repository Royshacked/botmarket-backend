import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeExits, routeSetupZones } from '../../services/protectionPlan.service.js'
import { computeRR, projectScenario, zoneLevel } from '../../services/setup.schema.js'

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

// The Phase-6 half of the same guarantee: exits are routed off the flat zones, and those are the
// EXECUTION PROJECTION of whichever scenario armed. If Talos ever stopped stamping it, a rival
// premise's stop would rest behind the position that actually opened — silently, exactly like the
// naked-entry bug above.
test('the exits belong to the premise that armed, not to the first one authored', () => {
    const RIVALS = {
        kind: 'setup', direction: 'long',
        scenarios: [
            { id: 's1', entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
              stop_zones: [{ lower: 234.8, upper: 235.9 }], tp_zones: [{ lower: 246, upper: 247.2 }], quantity: 100 },
            { id: 's2', entry_zones: [{ lower: 244, upper: 244.9, quantity: 60 }],
              stop_zones: [{ lower: 241, upper: 241.8 }], tp_zones: [{ lower: 252, upper: 253.5 }], quantity: 60 },
        ],
    }
    const armed = { ...RIVALS, ...projectScenario(RIVALS, 's2') }
    const { stop, tp } = routeSetupZones(armed)
    assert.equal(stop.nativeOrders[0].level, 241.0, "s2's stop, not s1's 234.8")
    assert.equal(tp.nativeOrders[0].level, 253.5, "s2's target, at the level the user named")
    assert.equal(stop.nativeOrders[0].quantity, 60, 'and s2\'s size — never 160')
})

test('a setup routes through zones, not through condition trees', async () => {
    // The dispatch lives inside routeExits so the execution path stays kind-blind: it asks one
    // function and gets one shape back, whatever authored the exits.
    const route = await routeExits(SETUP)
    assert.equal(route.stop.hasAny, true, 'a setup with a stop zone must produce a stop order')
    assert.equal(route.tp.hasAny, true)
    assert.equal(route.stop.monitorTree, null, 'a zone IS a price — nothing is left to the software monitor')
})

test('both legs rest at the edge FURTHER FROM ENTRY', () => {
    // The stop takes the far side so the zone has room to be a zone. The target takes the far side
    // because the far side IS the target the user named — the near edge is where Talos wakes to
    // offer a partial, not where the trade exits (docs/desks/mentor-talos.md, the TP window).
    const { stop, tp } = routeSetupZones(SETUP)
    assert.equal(stop.nativeOrders[0].level, 234.8, 'the zone gets room to be a zone')
    assert.equal(tp.nativeOrders[0].level, 247.2, 'the TP the user named, not the edge Talos wakes on')
})

test('the edges mirror for a short', () => {
    const { stop, tp } = routeSetupZones({ ...SETUP, direction: 'short' })
    assert.equal(stop.nativeOrders[0].level, 235.9)
    assert.equal(tp.nativeOrders[0].level, 246.0, 'a short falls TO its target — the lower edge')
    assert.equal(zoneLevel({ lower: 1, upper: 2 }, false), 2, 'the stop leg is the default')
})

test('a zero-width target rests at the level itself, whichever leg asks', () => {
    // The unconditional case: an exact price the user named. Both edges agree, so there is no window
    // and nothing to have a conversation in — it simply rests.
    assert.equal(zoneLevel({ lower: 246, upper: 246 }, true,  'tp'), 246)
    assert.equal(zoneLevel({ lower: 246, upper: 246 }, false, 'tp'), 246)
})

test('the resting orders can only ever BEAT the R:R the user was shown, never miss it', () => {
    // This used to assert equality, because the tp order rested on the same edge computeRR prices.
    // It cannot now — deliberately: R:R still measures to the near edge (what the trade pays if the
    // user banks at Talos's first offer every time) while the limit rests at the target. The
    // invariant that survives is the one that actually protects the user: the plan resting at the
    // broker is never WORSE than the plan they approved.
    const { stop, tp } = routeSetupZones(SETUP)
    const entry  = SETUP.entry_zones[0].upper          // computeRR's pessimistic fill for a long
    const resting = (tp.nativeOrders[0].level - entry) / (entry - stop.nativeOrders[0].level)
    assert.ok(resting >= computeRR(SETUP), `resting ${resting} must not undercut the advertised ${computeRR(SETUP)}`)

    // And the advertised number is exactly the window's near edge, so the floor is a real price.
    const floor = (SETUP.tp_zones[0].lower - entry) / (entry - stop.nativeOrders[0].level)
    assert.equal(Math.round(floor * 100) / 100, computeRR(SETUP))
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

// ── Conditional legs: the two rules that point in opposite directions ─────────
//
// docs/desks/talos-guards.md, "the exit asymmetry". A condition on an exit is a SENTENCE the model
// judges on its next read — the same thing an entry condition is. What differs is what happens
// while nobody is reading it, and the answer is not the same for the two legs.

test('a CONDITIONAL STOP still rests at the broker — the floor a condition may not remove', () => {
    // Talos proposes and never fires. A conditional stop that was the only protection would leave a
    // live position naked whenever the model is late, the process is down, the market gaps, or the
    // user is simply asleep. The condition may TIGHTEN the exit; it may never replace it.
    const conditional = {
        ...SETUP,
        stop_zones: [{ id: 'sz1', price: 234, lower: 234, upper: 234,
                       conditions: [{ id: 'sc1', text: 'out early if it closes below the 4hr VWAP' }] }],
    }
    const { stop } = routeSetupZones(conditional)
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
        tp_zones: [{ id: 'tp1', lower: 246, upper: 246 },
                   { id: 'tp2', lower: 252, upper: 252,
                     conditions: [{ id: 'tc1', text: 'only if volume confirms the push' }] }],
    }
    const { tp } = routeSetupZones(mixed)
    assert.deepEqual(tp.nativeOrders.map(o => o.level), [246], 'only the unconditional target rests')
    // …and the conditional one keeps its share of the size rather than handing it to the other leg.
    assert.equal(tp.nativeOrders[0].quantity, 50, 'the held-back leg still owns its 50')
})

test('a setup whose targets are ALL conditional rests nothing, and says so', () => {
    const allConditional = {
        ...SETUP,
        tp_zones: [{ id: 'tp1', lower: 246, upper: 246, conditions: [{ id: 'tc1', text: 'if momentum holds' }] }],
    }
    const { stop, tp } = routeSetupZones(allConditional)
    assert.equal(tp.hasAny, false, 'nothing for the broker to hold')
    assert.deepEqual(tp.nativeOrders, [])
    assert.equal(stop.hasAny, true, 'but the stop is still resting — that is the whole point')
})
