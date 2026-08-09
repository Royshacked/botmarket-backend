import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    zoneGate, zoneDistance, proximityGapMin, _isPreActive, _isExpiring, _nextCheckAt, _checkSetup,
    _nextStatus, _isPastExpiry, _effectiveVerdict, normalizeConditionResults, latchPatch, costPatch,
    validityBreach, breachPatch, awayEdge, adverseEdge,
    scenarioGate, liveScenarios, liveEntryZones, rollUpBreaches, scenarioState,
    positionGate, reviewDue, computeMetrics, rMultiple,
} from '../../monitoring/talos.monitor.service.js'
import { normalizeSetup } from '../../services/setup.schema.js'
import { buildToolsFor, symbolScope } from '../../monitoring/talos.assess.js'
import { statusesFor, AWAITING_CONFIRM } from '../../services/entity/vocabulary.js'

// Talos's gates. Everything here runs on EVERY wake for free — the expensive assessment only fires
// when these say so — so a wrong gate is either a missed entry or a wasted LLM call on every poll.

// The PLAN, stated flat. A price zone is a scenario now (docs/desks/mentor-talos.md), so
// fixtures are built through normalizeSetup rather than hand-written: that gives every one of them
// the same `scenarios` + execution projection a persisted document has, and a fixture can never
// drift from what the service would actually store.
const PLAN = {
    asset: 'NVDA', asset_class: 'stock',
    direction: 'long', type: 'swing', trade_mode: 'classical', timeframe: '1hr',
    entry_zones: [{ id: 'ez1', lower: 237.8, upper: 238.6, quantity: 100 }],
    stop_zones:  [{ id: 'sz1', lower: 234.8, upper: 235.9 }],
    conditions: [{ id: 'c1', text: 'CHoCH up on the 15m', weight: 'primary', mode: 'measured', persistence: 'live' }],
}

/** A persisted setup: identity + monitor state around a normalised plan. */
function mk(plan = {}, doc = {}) {
    return {
        id: 'setup_NVDA_1', kind: 'setup',
        status: 'looking',   // armed — the setup ladder's spelling, shared with calls
        armed_zone_id: null, armed_scenario_id: null,
        monitor_state: { next_check_at: null, check_count: 0, memo: null, timeline: [], conditions: {}, scenarios: {} },
        ...normalizeSetup({ ...PLAN, ...plan }),
        ...doc,
    }
}

const SETUP = mk()

// ─── Zone gate ────────────────────────────────────────────────────────────────

test('the gate trips inside the band and stays quiet outside it', () => {
    assert.equal(zoneGate(SETUP.entry_zones, 238.0).id, 'ez1')
    assert.equal(zoneGate(SETUP.entry_zones, 240.0), null)
    assert.equal(zoneGate(SETUP.entry_zones, 230.0), null)
})

test('both edges are inclusive, so a zero-width zone can still trip', () => {
    // An exact level the user named normalises to lower === upper; an exclusive test would mean
    // it could never fire.
    assert.ok(zoneGate([{ id: 'z', lower: 100, upper: 100 }], 100))
    assert.ok(zoneGate(SETUP.entry_zones, 237.8))
    assert.ok(zoneGate(SETUP.entry_zones, 238.6))
})

test('the first containing zone wins when several are armed', () => {
    const zones = [{ id: 'a', lower: 10, upper: 20 }, { id: 'b', lower: 15, upper: 25 }]
    assert.equal(zoneGate(zones, 18).id, 'a')
})

test('an unknown price never trips the gate', () => {
    // A failed quote must read as "don't know", never as "not in a zone, all clear".
    for (const p of [NaN, null, undefined, 'abc']) {
        assert.equal(zoneGate(SETUP.entry_zones, p), null, String(p))
    }
})

// ─── Proximity cadence ────────────────────────────────────────────────────────

test('distance is measured in zone widths, not absolute price', () => {
    // 0.8-wide zone; 238.6 → 239.4 is one full width away.
    assert.equal(zoneDistance(SETUP.entry_zones, 239.4).toFixed(2), '1.00')
    assert.equal(zoneDistance(SETUP.entry_zones, 238.0), 0, 'inside the zone = zero distance')
})

test('cadence tightens to the floor near a zone and relaxes to the ceiling far away', () => {
    assert.equal(proximityGapMin(SETUP, 238.0), 30,  'inside → min')
    assert.equal(proximityGapMin(SETUP, 239.0), 30,  'within a width → min')
    assert.equal(proximityGapMin(SETUP, 300.0), 240, 'miles away → max')
})

test('cadence is monotonic — approaching price never polls lazier', () => {
    const gaps = [300, 260, 245, 240, 238.7].map(p => proximityGapMin(SETUP, p))
    for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] <= gaps[i - 1], `${gaps}`)
})

test('an unknown price falls back to the lazy ceiling, not the floor', () => {
    // Polling flat-out on a broken price feed would burn quota for nothing.
    assert.equal(proximityGapMin(SETUP, NaN), 240)
    assert.equal(proximityGapMin({ ...SETUP, scenarios: [] }, 238), 240, 'nothing armed → nothing to approach')
})

// ─── Time gates ───────────────────────────────────────────────────────────────

const T = Date.parse('2026-07-26T12:00:00Z')

test('a future active_from means not live yet', () => {
    assert.equal(_isPreActive({ active_from: '2026-07-28T00:00:00Z' }, T), true)
    assert.equal(_isPreActive({ active_from: '2026-07-01T00:00:00Z' }, T), false)
    assert.equal(_isPreActive({ active_from: null }, T), false, 'no bound = already live')
})

test('expiry fires inside the review window and not before', () => {
    assert.equal(_isExpiring({ valid_until: '2026-07-26T12:10:00Z' }, T), true, '10m out → review')
    assert.equal(_isExpiring({ valid_until: '2026-07-26T14:00:00Z' }, T), false, '2h out → not yet')
    assert.equal(_isExpiring({ valid_until: '2026-07-26T11:00:00Z' }, T), true, 'already past → review')
})

test('a setup with no valid_until never expires', () => {
    assert.equal(_isExpiring({ valid_until: null }, T), false)
    assert.equal(_isExpiring({ valid_until: 'someday' }, T), false, 'an unparseable bound is not a live gate')
})

// ─── next_check_at clamping ───────────────────────────────────────────────────

test("the model's self-chosen cadence is clamped into the setup's band", () => {
    assert.equal(_nextCheckAt(SETUP, T, 1),    new Date(T + 30 * 60_000).toISOString(),  'too eager → floor')
    assert.equal(_nextCheckAt(SETUP, T, 9999), new Date(T + 240 * 60_000).toISOString(), 'too lazy → ceiling')
    assert.equal(_nextCheckAt(SETUP, T, 60),   new Date(T + 60 * 60_000).toISOString(),  'in band → honoured')
})

test('a missing or junk next_check_min falls back to the floor', () => {
    for (const v of [undefined, null, 'soon', NaN]) {
        assert.equal(_nextCheckAt(SETUP, T, v), new Date(T + 30 * 60_000).toISOString(), String(v))
    }
})

// ─── Tool mounting ────────────────────────────────────────────────────────────
// Conditions are TEXT — there is no declared `kind` left to gate on, and gating never served the
// model anyway (it read the factors back as prose either way). Everything is mounted and the model
// picks what the sentence needs.

const toolNames = (setup) => buildToolsFor(setup).map(t => t.name)

test('every read is mounted regardless of what the conditions say', () => {
    const bare = toolNames({ ...SETUP, conditions: [] })
    const rich = toolNames(SETUP)
    assert.deepEqual(bare, rich, 'the tool set no longer varies with the setup')
    for (const t of ['get_chart', 'get_structure', 'get_fvg', 'get_liquidity',
                     'get_orderblocks', 'get_false_breaks', 'get_short_interest']) {
        assert.ok(bare.includes(t), `${t} must be available`)
    }
})

test('the mounted set is still bounded — no duplicate schemas reach the model', () => {
    const names = toolNames(SETUP)
    assert.equal(new Set(names).size, names.length, 'a duplicated tool name is an API error')
})

// What bounds a wake is not which tools are mounted but which SYMBOLS may be read.
test('the read is scoped to the setup\'s own asset plus what it declared it leans on', () => {
    assert.deepEqual(symbolScope({ ...SETUP, referenced_symbols: ['SMH', 'smh'] }), ['NVDA', 'SMH'])
    assert.deepEqual(symbolScope(SETUP), ['NVDA'], 'no references → own asset only')
    assert.deepEqual(symbolScope({}), [], 'nothing to read is not a crash')
})

// ─── Per-wake cost ────────────────────────────────────────────────────────────
// Free-text conditions can't be priced before they run, so the build-time estimate is replaced by
// a measurement (docs/desks/mentor-talos.md).

test('tool calls accumulate across wakes, counting only the wakes that paid', () => {
    const first = costPatch(SETUP, ['get_chart', 'get_indicators'])
    assert.deepEqual(first['monitor_state.cost'], {
        tool_calls: 2, assessments: 1, last: ['get_chart', 'get_indicators'],
    })

    const priced = { ...SETUP, monitor_state: { cost: first['monitor_state.cost'] } }
    const second = costPatch(priced, ['get_chart'])
    assert.equal(second['monitor_state.cost'].tool_calls, 3)
    assert.equal(second['monitor_state.cost'].assessments, 2,
        'assessments counts PAID wakes — dividing by check_count would blend in the free arithmetic ones')
})

test('a wake that reached no tool leaves the tally untouched', () => {
    for (const calls of [[], null, undefined]) assert.deepEqual(costPatch(SETUP, calls), {})
})

// ─── The validity gate ────────────────────────────────────────────────────────
// The second arithmetic question every wake asks. Without it the only thing Talos can say while
// price is far away is "outside my zones, checking back in 30m" — forever, on a dead premise.

const VALID = { lower: 234, upper: 244, approach: 246, timeframe: '1hr', on_break: 'revise' }
// Carries a venue: without one the wake exits at the broker guard before any gate is reached.
const VENUE  = { broker: 'ctrader', accounts: ['a1'], mainAccountId: 'a1' }
const ARMED  = mk({}, VENUE)
const RANGED = mk({ validity: VALID }, VENUE)

test('the two edges mean different things and are reported separately', () => {
    assert.equal(validityBreach(RANGED, 233), 'adverse', 'below the floor → the premise broke')
    assert.equal(validityBreach(RANGED, 247), 'away',    'past the pivot → it ran away')
    assert.equal(validityBreach(RANGED, 238), null,      'inside → nothing to say')
    assert.equal(validityBreach(RANGED, 245), null,      'between upper and approach → still in play')
})

test('the edges mirror for a short', () => {
    const short = { ...SETUP, direction: 'short', validity: { lower: 230, upper: 244, approach: 228 } }
    assert.equal(validityBreach(short, 245), 'adverse', 'above the ceiling → broke')
    assert.equal(validityBreach(short, 227), 'away',    'below the pivot → ran away')
})

test('the envelope edge stands in when no away pivot was authored', () => {
    // Otherwise a range with only two edges would never report a runaway at all.
    const noPivot = { ...SETUP, validity: { lower: 234, upper: 244 } }
    assert.equal(awayEdge(noPivot), 244)
    assert.equal(adverseEdge(noPivot), 234, 'the adverse edge is the floor for a long')
    assert.equal(validityBreach(noPivot, 245), 'away')
})

test('an unknown price never breaches', () => {
    // A dead feed must read as "don't know", never as "the setup is broken".
    for (const p of [NaN, null, undefined, 'abc']) assert.equal(validityBreach(RANGED, p), null, String(p))
    assert.equal(validityBreach(SETUP, 100), null, 'no range → no gate')
})

test('a broken range reports the adverse side, the safer of the two', () => {
    // Adverse asks the user to look; away is only an FYI. On a malformed range, ask.
    const both = { ...SETUP, validity: { lower: 240, upper: 244, approach: 235 } }
    assert.equal(validityBreach(both, 238), 'adverse')
})

// ── The latch ──
// It lives PER SCENARIO (monitor_state.scenarios.<id>): one premise dying is not the setup dying.
const KEY = 'monitor_state.scenarios.s1'
const latched = (setup, status, id = 's1') => ({
    ...setup,
    monitor_state: { ...setup.monitor_state, scenarios: { [id]: { invalidation_status: status } } },
})

test('a break latches once — an oscillating price cannot spam the user', () => {
    const first = breachPatch(RANGED, RANGED.scenarios[0], 'adverse', 233, T)
    assert.equal(first.set[KEY].invalidation_status, 'fired')
    assert.equal(first.card, 'invalidated')

    const again = breachPatch(latched(RANGED, 'fired'), RANGED.scenarios[0], 'adverse', 232, T)
    assert.deepEqual(again.set, {}, 'nothing more to write')
    assert.equal(again.card, null, 'and nothing more to say')
})

test('a runaway is announced once and never kills the premise', () => {
    // Price can come back, and "you missed it" is not "you were wrong".
    const first = breachPatch(RANGED, RANGED.scenarios[0], 'away', 247, T)
    assert.equal(first.set[KEY].invalidation_status, 'drifting')
    assert.equal(first.card, 'ran_away')

    assert.equal(breachPatch(latched(RANGED, 'drifting'), RANGED.scenarios[0], 'away', 248, T).card, null)
})

test('a drifted scenario can still break the other way', () => {
    const broke = breachPatch(latched(RANGED, 'drifting'), RANGED.scenarios[0], 'adverse', 233, T)
    assert.equal(broke.set[KEY].invalidation_status, 'fired')
    assert.equal(broke.card, 'invalidated')
})

test('a dead premise is not re-armed by price wandering back into its zone', () => {
    assert.deepEqual(liveScenarios(latched(RANGED, 'fired')), [], 'fired is out')
    assert.equal(liveScenarios(latched(RANGED, 'drifting')).length, 1, 'drifting stays armed')
    assert.equal(scenarioGate(latched(RANGED, 'fired'), 238.0), null)
    assert.equal(scenarioGate(RANGED, 238.0).scenario.id, 's1')
})

test('on_break is honoured verbatim — and only once nothing is left standing', () => {
    const closeSc = mk({ validity: { ...VALID, on_break: 'close' } }, VENUE)
    const res = breachPatch(closeSc, closeSc.scenarios[0], 'adverse', 233, T)
    assert.equal(res.set[KEY].status, undefined, 'the scenario latch never carries a lifecycle')
    const rolled = rollUpBreaches(closeSc, { s1: 'fired' }, { scenario: closeSc.scenarios[0], edge: 'lower', reason: 'x' }, T)
    assert.equal(rolled.status, 'closed')
    assert.equal(rolled.closedReason, 'invalidated')

    const fyi = mk({ validity: { ...VALID, on_break: 'notify_only' } }, VENUE)
    assert.equal(breachPatch(fyi, fyi.scenarios[0], 'adverse', 233, T).card, 'invalidated_fyi')
    assert.equal(rollUpBreaches(fyi, { s1: 'fired' }, { scenario: fyi.scenarios[0] }, T).status, undefined,
        'notify_only never ends the setup')

    assert.equal(rollUpBreaches(RANGED, { s1: 'fired' }, { scenario: RANGED.scenarios[0] }, T).status, undefined,
        'revise keeps it alive to re-draw')
})

// ── The roll-up: a setup dies when nothing is left, not when the first premise falls ──

const RIVALS = mk({
    validity: undefined,
    scenarios: [
        { id: 's1', name: 'false break', entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
          stop_zones: [{ lower: 234.8, upper: 235.9 }], validity: { ...VALID, on_break: 'close' } },
        // A deliberately WIDER premise: the breakout can still come while price works the base, so
        // its floor sits under the shelf. This is what lets one premise die while the other stands.
        { id: 's2', name: 'break and go', entry_zones: [{ lower: 244, upper: 244.9, quantity: 60 }],
          stop_zones: [{ lower: 241, upper: 241.8 }], validity: { lower: 230, upper: 250, approach: 252, on_break: 'close' } },
    ],
}, VENUE)

test('one premise breaking leaves the setup alive and untouched', () => {
    const rolled = rollUpBreaches(RIVALS, { s1: 'fired' }, { scenario: RIVALS.scenarios[0], edge: 'lower', reason: 'broke' }, T)
    assert.deepEqual(rolled, {}, 'the document says nothing while a rival is still armed')
    assert.equal(liveScenarios({ ...RIVALS, monitor_state: { scenarios: { s1: { invalidation_status: 'fired' } } } })[0].id, 's2')
})

test('the LAST premise to break is the one whose on_break decides', () => {
    const half = { ...RIVALS, monitor_state: { ...RIVALS.monitor_state, scenarios: { s1: { invalidation_status: 'fired' } } } }
    const rolled = rollUpBreaches(half, { s2: 'fired' }, { scenario: RIVALS.scenarios[1], edge: 'lower', reason: 'gone' }, T)
    assert.equal(rolled.invalidation_status, 'fired')
    assert.match(rolled.invalidation_reason, /every scenario has broken/)
    assert.equal(rolled.status, 'closed')
})

test('proximity measures against EVERY live premise, not the projected one', () => {
    assert.equal(liveEntryZones(RIVALS).length, 2)
    // 244.4 sits in s2's zone — the projection still shows s1, and the loop must tighten anyway.
    assert.equal(proximityGapMin(RIVALS, 244.4), 30)
})

test('when the premise being SHOWN dies, the projection moves to a survivor', async () => {
    // The flat fields are what the confirm dialog, the watch row and the FE read. Leaving them on a
    // dead premise would keep advertising levels nobody is watching any more.
    const deps = stubDeps({ getPrice: async () => 233, getClose: async () => 233, onInvalidation: async () => {} })
    const res = await _checkSetup(RIVALS, T, deps)

    assert.equal(res.reason, 'invalidation')
    assert.equal(res.remaining, 1, 's2 is untouched at 233')
    assert.deepEqual(deps.writes[0].entry_zones, RIVALS.scenarios[1].entry_zones)
    assert.equal(deps.writes[0].status, undefined, 'one premise falling never closes the setup')
})

test('the card names the premise and says what is still standing', async () => {
    let info = null
    const deps = stubDeps({ getPrice: async () => 233, getClose: async () => 233, onInvalidation: async (_s, i) => { info = i } })
    await _checkSetup(RIVALS, T, deps)
    assert.equal(info.scenario, 'false break')
    assert.equal(info.remaining, 1)
})

test('the gate answers WHICH premise price reached', () => {
    assert.equal(scenarioGate(RIVALS, 238.0).scenario.id, 's1')
    assert.equal(scenarioGate(RIVALS, 244.4).scenario.id, 's2')
    assert.equal(scenarioGate(RIVALS, 241.0), null)
    assert.equal(scenarioState(RIVALS, 's1'), null, 'untouched premises have no state yet')
})

// ── Close, not touch (end to end) ──
const rangedDeps = (over = {}) => stubDeps({
    getPrice: async () => 233,          // the tick says breached
    getClose: async () => 233,          // and so does the close
    onInvalidation: async () => {},
    ...over,
})

test('a wick through the line does not kill the setup', () => Promise.resolve().then(async () => {
    // The tick is only the TRIGGER to look; the candle CLOSE is the verdict, and here it disagrees.
    let carded = false
    const deps = rangedDeps({ getClose: async () => 236, onInvalidation: async () => { carded = true } })
    const res = await _checkSetup(RANGED, T, deps)

    assert.equal(res.reason, 'scheduled', 'falls through to the normal reschedule')
    assert.equal(carded, false)
    assert.equal(deps.writes[0].invalidation_status, undefined, 'nothing latched')
}))

test('a confirmed close outside the range latches and fires the card', async () => {
    let info = null
    const deps = rangedDeps({ onInvalidation: async (_s, i) => { info = i } })
    const res = await _checkSetup(RANGED, T, deps)

    assert.equal(res.reason, 'invalidation')
    assert.equal(res.side, 'adverse')
    assert.equal(deps.writes[0].invalidation_status, 'fired')
    assert.equal(info.card, 'invalidated')
    assert.equal(info.price, 233, 'the card quotes the CLOSE, not the tick')
})

test('no candle means unknown, not broken', async () => {
    // Silence beats killing a live plan on a provider hiccup.
    let carded = false
    const deps = rangedDeps({ getClose: async () => null, onInvalidation: async () => { carded = true } })
    const res = await _checkSetup(RANGED, T, deps)
    assert.equal(res.reason, 'scheduled')
    assert.equal(carded, false)
})

test('the candle is only fetched when the tick suggests a breach', async () => {
    // The whole reason this is affordable every wake.
    let fetched = 0
    const deps = rangedDeps({ getPrice: async () => 238, getClose: async () => { fetched++; return 238 } })
    await _checkSetup(RANGED, T, deps)
    assert.equal(fetched, 0, 'price inside the range costs no candles')
})

test('a setup sitting in its own zone is never invalidated', async () => {
    // A zone trip is the setup doing exactly what it was built to do, whatever the range says.
    let carded = false
    const deps = rangedDeps({
        getPrice: async () => 238.0,            // inside ez1
        getClose: async () => 100,              // and wildly "breached", which must not matter
        onInvalidation: async () => { carded = true },
    })
    const res = await _checkSetup(RANGED, T, deps)
    assert.equal(carded, false)
    assert.equal(res.fired, true, 'the zone trip proceeds normally')
})

// ─── The `edit` verdict ───────────────────────────────────────────────────────
// It used to be persisted and SWALLOWED: on the verdict menu, written to the document, and never
// shown to anyone.

const EDIT_RAW = { verdict: 'edit', read: 'Shelf has moved up.', edit_proposal: { why: 'the 238 shelf is now 242' } }

test('a stale map fires the re-map card and latches', async () => {
    let carded = null
    const deps = stubDeps({ assess: async () => EDIT_RAW, onEditCard: async (_s, a) => { carded = a } })
    const res = await _checkSetup(ARMED, T, deps)

    assert.equal(res.edited, true)
    assert.equal(deps.writes[0].invalidation_status, 'fired')
    assert.equal(carded.verdict, 'edit')
    assert.equal(carded.edit_proposal.why, 'the 238 shelf is now 242')
})

test('an edit with no usable proposal fires nothing', async () => {
    // A re-map card with an empty "why" tells the user their plan is stale with no way to act.
    let carded = false
    const deps = stubDeps({
        assess: async () => ({ verdict: 'edit', read: 'hmm' }),
        onEditCard: async () => { carded = true },
    })
    const res = await _checkSetup(ARMED, T, deps)
    assert.equal(carded, false)
    assert.notEqual(res.edited, true)
})

test('the re-map card cannot repeat while the map stays stale', async () => {
    let cards = 0
    const deps = stubDeps({ assess: async () => EDIT_RAW, onEditCard: async () => { cards++ } })
    await _checkSetup({ ...ARMED, invalidation_status: 'fired' }, T, deps)
    assert.equal(cards, 0, 'already latched — the user has been told')
})

// ─── Condition results + the latch ────────────────────────────────────────────

const CONDS = [
    { id: 'c1', text: 'CHoCH up',     weight: 'primary',    persistence: 'live' },
    { id: 'c2', text: 'FDA approval', weight: 'confirming', persistence: 'latching' },
]

test('results are keyed to the DECLARED conditions, one row each', () => {
    const out = normalizeConditionResults([{ id: 'c1', met: 'yes', note: 'reclaimed' }], CONDS)
    assert.equal(out.length, 2)
    assert.deepEqual(out[0], { id: 'c1', met: 'yes', note: 'reclaimed' })
    assert.equal(out[1].met, 'unchecked', 'a condition the model ignored reads unchecked, never absent')
})

test('an answer for an id the setup never declared is dropped', () => {
    // A hallucinated id must not latch and must not count as a check.
    const out = normalizeConditionResults([{ id: 'c9', met: 'yes' }], CONDS)
    assert.deepEqual(out.map(c => c.id), ['c1', 'c2'])
    assert.ok(out.every(c => c.met === 'unchecked'))
})

test('met is three-state — a failed look never reads as "not happening"', () => {
    // Collapsing these to a boolean makes "the provider was down" indistinguishable from "I looked
    // and it is not there". One is a reason to wait; the other is a reason to go get the data.
    const [a] = normalizeConditionResults([{ id: 'c1', met: 'unchecked' }], CONDS)
    assert.equal(a.met, 'unchecked')
    assert.equal(normalizeConditionResults([{ id: 'c1', met: 'no' }], CONDS)[0].met, 'no')
    assert.equal(normalizeConditionResults([{ id: 'c1', met: true }], CONDS)[0].met, 'yes', 'a boolean is tolerated')
    assert.equal(normalizeConditionResults([{ id: 'c1', met: 'probably' }], CONDS)[0].met, 'unchecked', 'off-menu → unchecked, not met')
})

const SETUP_C = { ...SETUP, conditions: CONDS }

test('only a latching condition that actually resolved is remembered', () => {
    const patch = latchPatch(SETUP_C, [
        { id: 'c1', met: 'yes', note: 'in' },   // live — flips next candle, never latched
        { id: 'c2', met: 'yes', note: 'approved Jul 30' },
    ], T)
    assert.deepEqual(Object.keys(patch), ['monitor_state.conditions.c2'])
    assert.equal(patch['monitor_state.conditions.c2'].met, true)
    assert.equal(patch['monitor_state.conditions.c2'].note, 'approved Jul 30')
})

test('an unchecked or unmet condition never latches', () => {
    // Caching a failed look as a finding is the bug the three-state exists to prevent.
    for (const met of ['unchecked', 'no']) {
        assert.deepEqual(latchPatch(SETUP_C, [{ id: 'c2', met }], T), {}, met)
    }
})

test('an already-latched condition is not re-stamped', () => {
    // Re-stamping would move `at` forward every wake and lose when it actually resolved.
    const prior = { ...SETUP_C, monitor_state: { conditions: { c2: { met: true, at: 'earlier' } } } }
    assert.deepEqual(latchPatch(prior, [{ id: 'c2', met: 'yes' }], T), {})
})

// ─── The check, end to end (no IO) ────────────────────────────────────────────

// Every wake's write is captured on `deps.writes` rather than reaching Mongo. Before persistence was
// injectable these tests ran against a real getDb() that always failed and a _persist that always
// swallowed — so nothing could assert what a wake actually WROTE, which is how the pre-active
// status bug lived here undetected. `writes[i]` is the $set of the i-th persist call.
function stubDeps(over = {}) {
    const writes = []
    const entries = []
    return {
        isAssetOpen: () => true,
        nextOpenMs:  () => T + 3600_000,
        getPrice:    async () => 238.0,
        assess:      async () => ({ verdict: 'enter', read: 'Trigger is live.', next_check_min: 30 }),
        buildOrderPlan: async () => [{ accountId: 'a1', quantity: 100 }],
        onCard:         async () => {},
        onManualCard:   async () => {},
        onEditCard:     async () => {},
        onInvalidation: async () => {},
        getClose:       async () => null,
        assessPosition: async () => ({ verdict: 'hold', read: 'Doing what it should.', next_check_min: 30 }),
        onManageCard:   async () => {},
        writes,
        // The journal line rides alongside the $set. Kept as a SECOND array rather than folded into
        // `writes` so the existing assertions on writes[0] stay exact.
        entries,
        persist: async (_id, $set, entry = null) => { writes.push($set); entries.push(entry) },
        ...over,
    }
}

const LIVE = { ...SETUP, broker: 'ctrader', accounts: ['a1'], mainAccountId: 'a1', quantity: 100, valid_until: null }

test('a closed market skips the price fetch AND the assessment entirely', async () => {
    let fetched = false, assessed = false
    const res = await _checkSetup(LIVE, T, stubDeps({
        isAssetOpen: () => false,
        getPrice:    async () => { fetched = true; return 238 },
        assess:      async () => { assessed = true; return {} },
    }))
    assert.equal(res.reason, 'market_closed')
    assert.equal(fetched, false, 'a shut market must cost nothing')
    assert.equal(assessed, false)
})

test('price outside every zone reschedules without ever calling the model', async () => {
    let assessed = false
    const res = await _checkSetup(LIVE, T, stubDeps({
        getPrice: async () => 300,
        assess:   async () => { assessed = true; return {} },
    }))
    assert.equal(res.reason, 'scheduled')
    assert.equal(assessed, false, 'the cheap gate is the whole point')
})

// THE GATE. A zone trip buys an assessment, nothing more — only a fulfilled setup asks the user
// to act. Every non-enter verdict holds at 'looking' with no card.
for (const verdict of ['wait', 'stand_aside', 'edit']) {
    test(`a zone trip with verdict "${verdict}" does NOT ask the user to confirm — it watches`, async () => {
        let carded = false
        const res = await _checkSetup(LIVE, T, stubDeps({
            assess: async () => ({ verdict, read: 'Semis are diverging.', warning: 'SMH is red while NVDA taps the zone.' }),
            onCard: async () => { carded = true },
        }))
        assert.equal(carded, false, 'a setup Talos declined must not produce a confirm card')
        assert.equal(res.fired, undefined)
        assert.equal(res.watching, true)
        assert.equal(res.verdict, verdict)
    })
}

// One ladder, shared by every kind. Pinned as a set so re-spelling any rung fails here first,
// instead of silently at a gate that stops matching.
test('a setup runs the SAME ladder as every other kind — no private words', () => {
    for (const s of ['waiting', 'looking', 'hit', 'long', 'short', 'closed']) {
        assert.ok(statusesFor('setup').includes(s), `setup should allow '${s}'`)
        assert.ok(statusesFor('call').includes(s), `call should allow '${s}'`)
        assert.ok(statusesFor('idea').includes(s), `idea should allow '${s}'`)
    }
    // The synonyms this kind grew and shed. Each one broke a gate while it existed.
    for (const dead of ['unarmed', 'watching', 'ready']) {
        assert.ok(!statusesFor('setup').includes(dead), `setup must not speak '${dead}'`)
    }
})

test('_nextStatus walks the ladder: fulfilled → hit, otherwise → looking', () => {
    assert.equal(_nextStatus('enter', 'zone_trip'), 'hit')
    assert.equal(_nextStatus('wait', 'zone_trip'), 'looking')
    assert.equal(_nextStatus('stand_aside', 'zone_trip'), 'looking')
    assert.equal(_nextStatus('edit', 'zone_trip'), 'looking')
    // Price sitting inside a zone is armed_zone_id on a `looking` setup — being in a zone is a
    // detail of looking, not a lifecycle rung. It must never mint a status of its own again.
    for (const v of ['enter', 'wait', 'stand_aside', 'edit']) {
        for (const r of ['zone_trip', 'expiry_review']) {
            assert.notEqual(_nextStatus(v, r), 'watching')
        }
    }
})

// placeOrdersForIdea is kind-blind and used to gate on status === 'hit', which silently refused
// every setup confirm with reason 'not_hit'. The gate is now this shared set.
test("a fulfilled setup's status is placeable by the kind-blind execution path", () => {
    assert.ok(AWAITING_CONFIRM.includes(_nextStatus('enter', 'zone_trip')))
    assert.ok(AWAITING_CONFIRM.includes('hit'), 'an idea still reaches placement as hit')
})

test('price leaving the zone drops a watching setup back to armed, still without an LLM call', async () => {
    let assessed = false
    const res = await _checkSetup({ ...LIVE, status: 'looking' }, T, stubDeps({
        getPrice: async () => 300,                      // well outside every zone
        assess:   async () => { assessed = true; return {} },
    }))
    assert.equal(res.reason, 'scheduled')
    assert.equal(assessed, false, 'un-watching is arithmetic, not a read')
})

test('an enter verdict — the setup FULFILLED — is what fires the card', async () => {
    let carded = false
    const res = await _checkSetup(LIVE, T, stubDeps({ onCard: async () => { carded = true } }))
    assert.equal(carded, true)
    assert.equal(res.fired, true)
    assert.equal(res.verdict, 'enter')
})

test('the card names the tripped zone so the confirm dialog knows which one fired', async () => {
    let card = null
    await _checkSetup(LIVE, T, stubDeps({ onCard: async (_s, a) => { card = a } }))
    assert.equal(card.zone_id, 'ez1')
})

test('an enter verdict carries no warning', async () => {
    let card = null
    await _checkSetup(LIVE, T, stubDeps({ onCard: async (_s, a) => { card = a } }))
    assert.equal(card.warning, null)
})

// ── The execution projection (docs/desks/mentor-talos.md) ──
// The winning premise is stamped onto the flat fields every kind-blind consumer reads, so execution
// never learns that scenarios exist — and the rivals are simply no longer projected.

const RIVAL_LIVE = mk({
    valid_until: null,
    scenarios: [
        { id: 's1', name: 'false break', entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
          stop_zones: [{ lower: 234.8, upper: 235.9 }], tp_zones: [{ lower: 246, upper: 247.2 }],
          conditions: [{ id: 's1c1', text: 'sweep and reclaim of 238', weight: 'primary' }] },
        { id: 's2', name: 'break and go', entry_zones: [{ lower: 244, upper: 244.9, quantity: 60 }],
          stop_zones: [{ lower: 241, upper: 241.8 }], tp_zones: [{ lower: 252, upper: 253.5 }],
          conditions: [{ id: 's2c1', text: '1hr close above 244 on volume', weight: 'primary' }] },
    ],
}, VENUE)

test('the premise that fires is the one stamped onto the execution fields', async () => {
    const deps = stubDeps({ getPrice: async () => 244.4 })   // s2's zone, not the projected s1
    const res = await _checkSetup(RIVAL_LIVE, T, deps)

    assert.equal(res.fired, true)
    const $set = deps.writes[0]
    assert.equal($set.armed_scenario_id, 's2')
    assert.deepEqual($set.entry_zones, RIVAL_LIVE.scenarios[1].entry_zones)
    assert.deepEqual($set.stop_zones,  RIVAL_LIVE.scenarios[1].stop_zones)
    assert.deepEqual($set.tp_zones,    RIVAL_LIVE.scenarios[1].tp_zones)
})

test('QUANTITY IS NEVER SUMMED — the winner takes the whole trade, and only its own size', async () => {
    // Two rivals of 100 and 60. The document that placed the order must never say 160.
    for (const [price, want] of [[238.0, 100], [244.4, 60]]) {
        let planned = null
        const deps = stubDeps({ getPrice: async () => price, buildOrderPlan: async (s) => { planned = s; return [{ accountId: 'a1', quantity: s.quantity }] } })
        await _checkSetup(RIVAL_LIVE, T, deps)
        assert.equal(planned.quantity, want, `at ${price}`)
        assert.equal(deps.writes[0].quantity, want, `persisted at ${price}`)
    }
})

test('the order plan is built from the PROJECTED setup, not the document as it was read', async () => {
    let planned = null
    const deps = stubDeps({ getPrice: async () => 244.4, buildOrderPlan: async (s) => { planned = s; return [{ accountId: 'a1', quantity: 60 }] } })
    await _checkSetup(RIVAL_LIVE, T, deps)
    // protectionPlan.routeSetupZones reads these off the doc to build the resting exits.
    assert.deepEqual(planned.stop_zones, RIVAL_LIVE.scenarios[1].stop_zones)
    assert.deepEqual(planned.tp_zones,   RIVAL_LIVE.scenarios[1].tp_zones)
})

test('the wake judges the armed premise — the rival is not on the table', async () => {
    let hit = null
    const deps = stubDeps({ getPrice: async () => 244.4, assess: async (_s, h) => { hit = h; return { verdict: 'wait', read: 'not yet' } } })
    await _checkSetup(RIVAL_LIVE, T, deps)
    assert.equal(hit.scenario.id, 's2')
    assert.equal(hit.zone.id, RIVAL_LIVE.scenarios[1].entry_zones[0].id)
})

test('a per-condition answer is recorded against the armed premise, not the rival', async () => {
    const deps = stubDeps({
        getPrice: async () => 244.4,
        assess:   async () => ({ verdict: 'wait', read: 'not yet', conditions: [{ id: 's2c1', met: 'no', note: 'no close yet' }] }),
    })
    await _checkSetup(RIVAL_LIVE, T, deps)
    const rows = deps.writes[0]['monitor_state.last_assessment'].conditions
    assert.deepEqual(rows.map(r => r.id), ['c1', 's2c1'], 'root ∪ armed — s1c1 is a different trade')
})

test('an off-menu verdict is coerced to wait rather than acted on', async () => {
    const res = await _checkSetup(LIVE, T, stubDeps({
        assess: async () => ({ verdict: 'YOLO', read: 'send it' }),
    }))
    assert.equal(res.verdict, 'wait')
})

test('a failed assessment reschedules instead of firing a card', async () => {
    let carded = false
    const res = await _checkSetup(LIVE, T, stubDeps({
        assess: async () => ({ _failReason: 'truncated' }),
        onCard: async () => { carded = true },
    }))
    assert.equal(res.failed, true)
    assert.equal(carded, false)
})

test('a card that throws does not fail the check — the status change already persisted', async () => {
    const res = await _checkSetup(LIVE, T, stubDeps({
        onCard: async () => { throw new Error('social chat down') },
    }))
    assert.equal(res.fired, true)
})

test('a pre-active setup sleeps until it opens, with no price fetch', async () => {
    let fetched = false
    const res = await _checkSetup({ ...LIVE, active_from: '2026-07-28T00:00:00Z' }, T, stubDeps({
        getPrice: async () => { fetched = true; return 238 },
    }))
    assert.equal(res.reason, 'pre_active')
    assert.equal(fetched, false)
})

// THE ORPHAN BUG. Sleeping until active_from must NOT demote the status: 'waiting' is outside
// ACTIVE_STATUSES, so the wake-up time being stamped here would sit on a document the poll query
// can never select again — one journal line, then silence for the life of the setup.
test('a pre-active setup keeps its status — sleeping is not disarming', async () => {
    const deps = stubDeps()
    await _checkSetup({ ...LIVE, active_from: '2026-07-28T00:00:00Z' }, T, deps)

    assert.equal(deps.writes.length, 1)
    const $set = deps.writes[0]
    assert.equal($set.status, undefined, 'must not write a status at all')
    assert.equal($set['monitor_state.next_check_at'], '2026-07-28T00:00:00.000Z', 'wakes exactly at active_from')
})

test('a setup with no trading venue costs nothing — no price fetch, no assessment', async () => {
    // Live positions never reach here at all (the poll query excludes them); this is the guard for
    // a setup whose broker vanished between the read and the check.
    let fetched = false, assessed = false
    const res = await _checkSetup({ ...LIVE, broker: null }, T, stubDeps({
        getPrice: async () => { fetched = true; return 238 },
        assess:   async () => { assessed = true; return {} },
    }))
    assert.equal(res.reason, 'no_venue')
    assert.equal(fetched, false)
    assert.equal(assessed, false)
})

// ─── The execution handoff ────────────────────────────────────────────────────

test('a trigger builds the order plan — a hit with no plan would dead-end at the dialog', async () => {
    let patched = null
    const res = await _checkSetup(LIVE, T, stubDeps({
        buildOrderPlan: async (s) => { patched = s.id; return [{ accountId: 'a1', quantity: 100 }] },
    }))
    assert.equal(res.fired, true)
    assert.equal(res.orderState, 'awaiting_confirm')
    assert.equal(patched, 'setup_NVDA_1', 'the plan is built from the setup itself')
})

test('a trigger while the market is closed parks the plan and stays silent', async () => {
    // The expiry path can reach a trigger out of hours; the plan is still built, but the card
    // waits for the open rather than asking for a confirm nobody can place.
    let carded = false
    const res = await _checkSetup({ ...LIVE, valid_until: '2026-07-26T12:05:00Z' }, T, stubDeps({
        isAssetOpen: () => false,
        assess:      async () => ({ verdict: 'enter', read: 'Zone tagged.' }),
        onCard:      async () => { carded = true },
    }))
    assert.equal(res.orderState, 'awaiting_market')
    assert.equal(carded, false, 'awaiting_market defers silently')
})

test('a manual setup gets the fill card, not an order plan', async () => {
    let planned = false, manualCard = false, confirmCard = false
    const res = await _checkSetup({ ...LIVE, broker: 'manual' }, T, stubDeps({
        buildOrderPlan: async () => { planned = true; return [] },
        onManualCard:   async () => { manualCard = true },
        onCard:         async () => { confirmCard = true },
    }))
    assert.equal(res.manual, true)
    assert.equal(planned, false, 'manual places at the user\'s own broker — nothing to plan')
    assert.ok(manualCard && !confirmCard)
})

test('no resolvable accounts still alerts, but with nothing to place', async () => {
    let carded = false
    const res = await _checkSetup(LIVE, T, stubDeps({
        buildOrderPlan: async () => [],
        onCard:         async () => { carded = true },
    }))
    assert.equal(res.fired, true)
    assert.equal(res.orderState, null, 'no plan → no orderState')
    assert.equal(carded, true, 'the user still hears that their level printed')
})

test('a failed order-plan build still surfaces the trigger instead of losing it', async () => {
    const res = await _checkSetup(LIVE, T, stubDeps({
        buildOrderPlan: async () => { throw new Error('broker unreachable') },
    }))
    assert.equal(res.fired, true)
    assert.equal(res.orderState, null)
})

test('let_expire at the review window closes the setup', async () => {
    const res = await _checkSetup({ ...LIVE, valid_until: '2026-07-26T12:05:00Z' }, T, stubDeps({
        getPrice: async () => 300,   // nowhere near a zone — this is purely the expiry path
        assess:   async () => ({ verdict: 'let_expire', read: 'Window closed, no trigger.' }),
    }))
    assert.equal(res.closed, true)
})

test('expiry with any other verdict keeps the setup alive', async () => {
    const res = await _checkSetup({ ...LIVE, valid_until: '2026-07-26T12:05:00Z' }, T, stubDeps({
        getPrice: async () => 300,
        assess:   async () => ({ verdict: 'edit', read: 'Worth rolling.', edit_proposal: { why: 'shelf moved' } }),
    }))
    assert.notEqual(res.closed, true)
    assert.equal(res.verdict, 'edit')
})

// ─── Past-expiry terminator ────────────────────────────────────────────────────
// _isExpiring stays true FOREVER once past valid_until, so without this a setup whose window has
// closed pays a full chart+vision assessment every single cadence, indefinitely.

test('_isPastExpiry separates "review window" from "actually over"', () => {
    assert.equal(_isPastExpiry({ valid_until: '2026-07-26T12:05:00Z' }, T), false, 'inside the window')
    assert.equal(_isPastExpiry({ valid_until: '2026-07-26T11:55:00Z' }, T), true,  'past it')
    assert.equal(_isPastExpiry({ valid_until: null }, T), false, 'no expiry never expires')
})

test('_effectiveVerdict: let_expire is only on the menu for an expiry review', () => {
    assert.equal(_effectiveVerdict('let_expire', 'zone_trip', false), 'stand_aside')
    assert.equal(_effectiveVerdict('let_expire', 'expiry_review', false), 'let_expire')
})

test('_effectiveVerdict: past expiry and still not committing → terminate', () => {
    for (const v of ['wait', 'stand_aside', 'edit']) {
        assert.equal(_effectiveVerdict(v, 'expiry_review', true), 'let_expire', `${v} past expiry`)
    }
    assert.equal(_effectiveVerdict('enter', 'expiry_review', true), 'enter', 'a late trigger is still a trigger')
    // Inside the window (not yet past) these stay legitimate.
    for (const v of ['wait', 'stand_aside', 'edit']) {
        assert.equal(_effectiveVerdict(v, 'expiry_review', false), v, `${v} inside the window`)
    }
})

test('a past-expiry setup that keeps saying wait is closed, not re-assessed forever', async () => {
    const deps = stubDeps({
        getPrice: async () => 300,
        assess:   async () => ({ verdict: 'wait', read: 'Still nothing here.' }),
    })
    const res = await _checkSetup({ ...LIVE, valid_until: '2026-07-26T11:00:00Z' }, T, deps)

    assert.equal(res.closed, true)
    assert.equal(deps.writes[0].status, 'closed')
    assert.equal(deps.writes[0].closedReason, 'expired')
})

// ─── Past entry ───────────────────────────────────────────────────────────────
// The journal used to stop dead at the entry card — the record went silent at the moment it
// mattered most. What runs here is deliberately small: the exits rest at the BROKER, so the
// position is protected without anyone watching it.

const FILLED = { ...ARMED, status: 'long', ordersPlacedAt: T - 60_000, quantity: 100 }

test('a live setup takes the position path, never the readiness gate', async () => {
    let assessed = false, priced = false
    const deps = stubDeps({
        assess:   async () => { assessed = true; return {} },
        getPrice: async () => { priced = true; return 238 },
    })
    await _checkSetup(FILLED, T, deps)
    assert.equal(assessed, false, 'a live position has no use for a zone trip')
    assert.equal(priced, false, 'and costs no quote')
})

test('the first wake after a fill writes the entry into the journal', async () => {
    const deps = stubDeps()
    const res = await _checkSetup(FILLED, T, deps)

    assert.equal(res.promoted, true)
    const $set = deps.writes[0]
    assert.equal($set['position_state.entry.direction'], 'long')
    assert.equal($set['position_state.entry.size'], 100)
    assert.equal($set['position_state.entry.fill_at'], new Date(T - 60_000).toISOString(),
        'stamped when the orders were placed, not when we noticed')
    assert.equal($set['position_state.phase'], 'running')
})

// The fill also SEEDS what an in-position gate measures against. Without this the gate reads
// undefined stops and an empty target ladder, and silently never trips — the failure looks like
// "the manager isn't doing anything" rather than like a missing field.

test('the fill freezes the working stop and the target ladder onto the position', async () => {
    const withTargets = { ...FILLED, ...mk({
        tp_zones: [{ lower: 260, upper: 261 }, { lower: 244, upper: 245 }],   // authored far-then-near
    }), status: 'long', ordersPlacedAt: T - 60_000, quantity: 100 }

    const deps = stubDeps()
    await _checkSetup(withTargets, T, deps)
    const $set = deps.writes[0]

    assert.equal($set['position_state.stop.initial'], 234.8, 'the WIDEST stop edge, not stop_zones[0].upper')
    assert.equal($set['position_state.stop.current'], 234.8, 'current starts equal to initial')
    assert.deepEqual($set['position_state.targets'], [
        { price: 244, hit_at: null },
        { price: 260, hit_at: null },
    ], 'nearest-first — the order price reaches them, not the order they were typed')
})

test('a short seeds the opposite edges', async () => {
    const short = { ...mk({
        direction: 'short',
        stop_zones: [{ lower: 240, upper: 241 }],
        tp_zones:   [{ lower: 220, upper: 221 }, { lower: 230, upper: 231 }],
    }, VENUE), status: 'short', ordersPlacedAt: T - 60_000, quantity: 100 }

    const deps = stubDeps()
    await _checkSetup(short, T, deps)
    const $set = deps.writes[0]

    assert.equal($set['position_state.stop.initial'], 241, 'a short works against the HIGH edge')
    assert.deepEqual($set['position_state.targets'].map(t => t.price), [231, 221], 'falls INTO its targets')
})

test('a setup with no targets seeds an empty ladder rather than undefined', async () => {
    // The gate iterates this. `undefined` would throw on the first in-position wake.
    const deps = stubDeps()
    await _checkSetup(FILLED, T, deps)
    assert.deepEqual(deps.writes[0]['position_state.targets'], [])
})

test('the frozen stop is never re-stamped from the plan on a later wake', async () => {
    // What protects the position is the order resting at the broker. If the scenario is edited
    // afterwards, the level the gate measures against must not quietly follow it.
    const promoted = { ...FILLED, position_state: { entry: { fill_at: '2026-07-26T11:00:00Z' }, stop: { initial: 234.8, current: 236 } } }
    const deps = stubDeps()
    await _checkSetup(promoted, T, deps)
    assert.equal(deps.writes[0]['position_state.stop.initial'], undefined)
    assert.equal(deps.writes[0]['position_state.stop.current'], undefined, 'a moved stop stays moved')
})

test('later wakes stay quiet — an idle line every cadence is noise, not a monologue', async () => {
    const promoted = { ...FILLED, position_state: { entry: { fill_at: '2026-07-26T11:00:00Z' } } }
    const deps = stubDeps()
    const res = await _checkSetup(promoted, T, deps)

    assert.equal(res.reason, 'in_position_idle')
    assert.equal(deps.writes[0]['position_state.entry.fill_at'], undefined, 'nothing re-stamped')
})

test("a setup awaiting the user's confirm says nothing the card didn't already say", async () => {
    const deps = stubDeps()
    const res = await _checkSetup({ ...ARMED, status: 'hit' }, T, deps)
    assert.equal(res.reason, 'awaiting_fill')
    assert.equal(deps.writes.length, 1, 'the schedule moves and nothing else')
})

test('a live position parks on the lazy end of the cadence', async () => {
    // Nothing here is time-critical: the broker holds the protective orders.
    const deps = stubDeps()
    await _checkSetup(FILLED, T, deps)
    assert.equal(deps.writes[0]['monitor_state.next_check_at'], new Date(T + 240 * 60_000).toISOString())
})

// ─── In-position gate + metrics ───────────────────────────────────────────────
// These run on EVERY in-position wake for free, and the expensive management read fires only when
// they say so. A gate that never trips is a manager that does nothing; one that always trips is an
// LLM call every poll on every open position — the cost that scales with users.

// entry 100, initial stop 96 → risk 4, so the adverse band is 1.00 wide (0.25R).
const POS = (over = {}) => ({
    entry: { fill_price: 100, direction: 'long' },
    stop:  { initial: 96, current: 96 },
    targets: [{ price: 110, hit_at: null }, { price: 120, hit_at: null }],
    ...over,
})

test('adverse fires BEFORE the stop, while there is still a decision to make', () => {
    // The broker owns "the stop was hit". This is the look before it.
    assert.equal(positionGate(POS(), 96.9).flag, 'adverse', 'inside the quarter-R band')
    assert.equal(positionGate(POS(), 99).flag, null, 'comfortably above → nothing to say')
})

test('a moved stop moves the adverse band with it', () => {
    // The band tracks the WORKING stop; the risk it is a quarter of stays the original.
    const moved = POS({ stop: { initial: 96, current: 104 } })
    assert.equal(positionGate(moved, 104.9).flag, 'adverse')
})

test('scale_out trips at OR BEYOND the target, so a gap through it still fires', () => {
    // targets[].price is the near edge of the zone. An "inside the band" test would miss a gap.
    assert.equal(positionGate(POS(), 110).flag, 'scale_out', 'exactly at the edge')
    assert.equal(positionGate(POS(), 130).flag, 'scale_out', 'gapped clean past both')
    assert.equal(positionGate(POS(), 130).target.price, 110, 'the NEAREST un-hit target, not the furthest')
})

test('a target already taken is not offered again', () => {
    // Stop moved to entry so `breakeven` cannot fire and this isolates the scale_out tier — by 112
    // the position is +3R, which would otherwise trip breakeven first and mask the question.
    const partly = POS({
        stop: { initial: 96, current: 100 },
        targets: [{ price: 110, hit_at: '2026-07-26T11:00:00Z' }, { price: 120, hit_at: null }],
    })
    assert.equal(positionGate(partly, 112).flag, null, '110 is spent and 120 is not reached')
    assert.equal(positionGate(partly, 120).target.price, 120)
})

test('pressing the stop outranks a target in reach — no victory lap on a losing wake', () => {
    // Priority order is load-bearing: both conditions can be true at once on a whipsaw.
    const wide = POS({ stop: { initial: 96, current: 109.5 }, targets: [{ price: 110, hit_at: null }] })
    assert.equal(positionGate(wide, 110).flag, 'adverse')
})

test('breakeven fires once and stops once the stop is protected', () => {
    assert.equal(positionGate(POS(), 104).flag, 'breakeven', '+2R with the stop still below entry')
    const beProtected = POS({ stop: { initial: 96, current: 100 } })
    assert.equal(positionGate(beProtected, 104).flag, null, 'already protected → nothing free left')
})

test('a short mirrors every edge', () => {
    const short = { entry: { fill_price: 100, direction: 'short' }, stop: { initial: 104, current: 104 },
                    targets: [{ price: 90, hit_at: null }] }
    assert.equal(positionGate(short, 103.1).flag, 'adverse')
    assert.equal(positionGate(short, 88).flag, 'scale_out', 'a short falls INTO its target')
    assert.equal(positionGate(short, 96).flag, 'breakeven')
})

test('an unknown price never trips a gate', () => {
    // A failed quote must read as "don't know", never as "all clear" — and never as an entry to act on.
    for (const p of [NaN, null, undefined, 'abc']) assert.equal(positionGate(POS(), p).flag, null, String(p))
})

test('an unseeded position gates to nothing rather than throwing', () => {
    // This is exactly the state before the fill seeds stop/targets — it must be inert, not fatal.
    assert.equal(positionGate({}, 100).flag, null)
    assert.equal(positionGate({ entry: { fill_price: 100 } }, 100).flag, null, 'no stop → no risk → no band')
})

test('R is measured from the ORIGINAL risk, so moving a stop never rewrites it', () => {
    assert.equal(rMultiple(100, 108, 96, 'long'), 2)
    assert.equal(rMultiple(100, 92, 104, 'short'), 2, 'a short gains as price falls')
    assert.equal(rMultiple(100, 100, 100, 'long'), null, 'zero risk is not 0R, it is unanswerable')
    assert.equal(rMultiple(100, 108, null, 'long'), null)
})

test('the R extremes are carried across wakes, not recomputed from now', () => {
    // A position that spiked to +2R and gave it back has to still know it did — that is the whole
    // difference between "let it run" and "you gave it back".
    const spiked = POS({ metrics: { mae: -0.5, mfe: 2 } })
    const m = computeMetrics(spiked, 100, T)
    assert.equal(m.r_multiple_now, 0)
    assert.equal(m.mfe, 2, 'the peak survives the round trip')
    assert.equal(m.mae, -0.5)
})

test('an unpriceable wake preserves the extremes rather than resetting them', () => {
    const m = computeMetrics(POS({ metrics: { mae: -1, mfe: 3 } }), NaN, T)
    assert.equal(m.r_multiple_now, null)
    assert.deepEqual([m.mae, m.mfe], [-1, 3])
})

test('a fresh position starts its extremes at zero, not at the current R', () => {
    // Seeding mae from a first wake already in profit would hide a drawdown that comes later.
    const m = computeMetrics(POS(), 104, T)   // risk 4 → 104 is +1R
    assert.equal(m.mfe, 1)
    assert.equal(m.mae, 0, 'never adverse yet → 0, not +1')
})

test('a review is due a full cadence after the last read, and immediately if there never was one', () => {
    const cadence = { min: 5, max: 30 }
    assert.equal(reviewDue({ entry: { fill_at: new Date(T - 31 * 60_000).toISOString() } }, T, cadence), true)
    assert.equal(reviewDue({ entry: { fill_at: new Date(T - 10 * 60_000).toISOString() } }, T, cadence), false,
        'a fresh position waits one cadence rather than being read on arrival')
    assert.equal(reviewDue({}, T, cadence), true, 'no timestamp at all → look now')
})

test('the last management read resets the review clock, not the fill', () => {
    const cadence = { min: 5, max: 30 }
    const ps = { entry: { fill_at: new Date(T - 5 * 60_000).toISOString() },
                 last_management: { at: new Date(T - 31 * 60_000).toISOString() } }
    assert.equal(reviewDue(ps, T, cadence), true, 'read 31m ago wins over a 5m-old fill')
})
