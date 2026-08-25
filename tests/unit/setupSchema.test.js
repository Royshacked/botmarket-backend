import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    buildLadder, buildCadence, normalizeZone, normalizeZones, scenarioQuantity,
    normalizeConditions, normalizeSymbols, normalizeValidity, validityProblems, rangeProblems,
    normalizeSetup, setupReadiness, computeRR, TF_RUNGS,
    normalizeScenarios, pickScenario, projectScenario, scenarioView, declaredConditions, scenarioLabel,
    stopEdge, targetEdges, targetLevels, clampGuards, addEntryLeg, legQuantity, pendingLegs, mayScaleIn, CONDITION_MODES, TRADE_MODES,
} from '../../services/setup.schema.js'
import { MODES } from '../../services/analysisModes.js'

// The `setup` entity contract (docs/desks/mentor-talos.md). Mentor authors loosely, Talos monitors
// strictly — this module is the seam, so these tests pin the coercions the monitor depends on.

// ─── Ladder ───────────────────────────────────────────────────────────────────

test('ladder is a contiguous coarse→fine window around the authored timeframe', () => {
    assert.deepEqual(buildLadder('1hr'), ['4hr', '2hr', '1hr', '30min', '15min'])
    // Order always matches the canonical rung order, never the model's whim.
    const ladder = buildLadder('15min')
    const idx = ladder.map(tf => TF_RUNGS.indexOf(tf))
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b))
})

test('ladder clamps at both ends rather than running off the rung list', () => {
    // Both ends yield a SHORTER ladder rather than wrapping or padding.
    assert.deepEqual(buildLadder('month'), ['month', 'week', 'day'])
    // The fine end stops at 5min: 1min is off-plan at the provider (402), so offering it would hand
    // the monitor a rung whose fetch can only fail. Note a 1min-authored setup therefore has NO rung
    // at its own timeframe — which is why Mentor must not author one.
    assert.deepEqual(buildLadder('1min'), ['15min', '5min'])
    assert.deepEqual(buildLadder('5min'), ['30min', '15min', '5min'])
})

test('ladder falls back for an unknown timeframe instead of returning empty', () => {
    // An empty ladder would leave the monitor's tool enum with no valid value at all.
    for (const bad of [null, undefined, '', 'fortnight', 42]) {
        assert.ok(buildLadder(bad).length > 0, String(bad))
    }
})

test('ladder accepts loose timeframe spellings via normalizeTimeframe', () => {
    assert.deepEqual(buildLadder('4h'), buildLadder('4hr'))
    assert.deepEqual(buildLadder('daily'), buildLadder('day'))
})

// ─── Cadence ──────────────────────────────────────────────────────────────────

test('cadence widens with the horizon and is always min < max', () => {
    const intraday = buildCadence('intraday')
    const swing    = buildCadence('swing')
    assert.ok(intraday.min < intraday.max)
    assert.ok(swing.min > intraday.min, 'a swing polls lazier than an intraday')
    assert.deepEqual(buildCadence('nonsense'), buildCadence('swing'), 'unknown horizon → swing')
})

test('cadence is a fresh object per call (callers mutate their copy)', () => {
    const a = buildCadence('day')
    a.min = 999
    assert.notEqual(buildCadence('day').min, 999)
})

// ─── Zones ────────────────────────────────────────────────────────────────────

test('zone edges are sorted, so a flipped lower/upper is still monitorable', () => {
    const z = normalizeZone({ lower: 240, upper: 238 }, 0, 'ez')
    assert.equal(z.lower, 238)
    assert.equal(z.upper, 240)
})

test('a single price collapses to a zero-width zone rather than being dropped', () => {
    // Dropping it would silently lose the user's stop — worse than monitoring an exact level.
    const z = normalizeZone({ price: 235.5, quantity: 10 }, 0, 'sz')
    assert.equal(z.lower, 235.5)
    assert.equal(z.upper, 235.5)
    assert.equal(z.quantity, 10)
})

test('one missing edge mirrors the other instead of producing NaN', () => {
    assert.deepEqual(
        [normalizeZone({ lower: 100 }, 0, 'ez').upper, normalizeZone({ upper: 100 }, 0, 'ez').lower],
        [100, 100],
    )
})

test('a zone with no usable price is dropped', () => {
    assert.equal(normalizeZone({ note: 'somewhere around the shelf' }, 0, 'ez'), null)
    assert.equal(normalizeZone(null, 0, 'ez'), null)
    assert.deepEqual(normalizeZones([{ lower: 'abc' }, { lower: 1, upper: 2 }], 'ez').length, 1)
})

test('zone ids are auto-assigned by position when the model omits them', () => {
    const zones = normalizeZones([{ lower: 1, upper: 2 }, { lower: 3, upper: 4, id: 'custom' }], 'ez')
    assert.deepEqual(zones.map(z => z.id), ['ez1', 'custom'])
})

test('a non-positive or absent quantity becomes null, never 0', () => {
    // 0 would read as "size it at zero"; null reads as "not sized yet" and blocks readiness.
    for (const q of [0, -5, 'abc', undefined]) {
        assert.equal(normalizeZone({ lower: 1, upper: 2, quantity: q }, 0, 'ez').quantity, null, String(q))
    }
})

test('a scenario is sized by its own entry legs, and is null when nothing is sized', () => {
    assert.equal(scenarioQuantity([{ quantity: 100 }, { quantity: 50 }]), 150)
    assert.equal(scenarioQuantity([{ quantity: null }]), null)
    assert.equal(scenarioQuantity([]), null)
})

// ─── conditions[] ─────────────────────────────────────────────────────────────

test('a condition with no text is dropped — the monitor would have nothing to check', () => {
    assert.equal(normalizeConditions([{ id: 'c1' }]).length, 0)
    assert.equal(normalizeConditions([{ id: 'c1', text: '   ' }]).length, 0)
})

test('weight defaults to confirming, never to primary', () => {
    // Defaulting to primary would silently promote a throwaway condition into the trigger.
    assert.equal(normalizeConditions([{ text: 'tape holding' }])[0].weight, 'confirming')
    assert.equal(normalizeConditions([{ text: 'x', weight: 'primary' }])[0].weight, 'primary')
})

test('an unstamped condition re-checks and claims no test — the safe defaults', () => {
    // live: caching something that could flip is a WRONG ANSWER; re-checking is merely a wasted call.
    // judgment: claiming "measured" without a named test would overstate how hard the check is.
    const [c] = normalizeConditions([{ text: 'NVDA weak' }])
    assert.equal(c.persistence, 'live')
    assert.equal(c.mode, 'judgment')
    assert.equal(normalizeConditions([{ text: 'x', persistence: 'latching' }])[0].persistence, 'latching')
    assert.equal(normalizeConditions([{ text: 'x', mode: 'measured' }])[0].mode, 'measured')
    assert.equal(normalizeConditions([{ text: 'x', persistence: 'sometimes' }])[0].persistence, 'live')
})

// The monitor latches resolved conditions BY ID, so an id that moves re-points a past finding at a
// different condition. These three properties are what make that safe.
test('authored ids win, so a re-emit keeps its findings attached', () => {
    const out = normalizeConditions([{ id: 'c7', text: 'a' }, { id: 'c9', text: 'b' }])
    assert.deepEqual(out.map(c => c.id), ['c7', 'c9'])
})

test('the positional fallback keys off the original index, so dropping one never renumbers the rest', () => {
    const out = normalizeConditions([{ text: 'a' }, { text: '' }, { text: 'c' }])
    assert.deepEqual(out.map(c => c.id), ['c1', 'c3'], 'c3 stays c3 even though c2 vanished')
})

test('duplicate ids are suffixed, never silently merged', () => {
    const out = normalizeConditions([{ id: 'c1', text: 'a' }, { id: 'c1', text: 'b' }])
    assert.deepEqual(out.map(c => c.id), ['c1', 'c1_2'])
    assert.equal(new Set(out.map(c => c.id)).size, 2)
})

test('a non-array conditions degrades to an empty list', () => {
    for (const bad of [null, undefined, 'structure', {}]) {
        assert.deepEqual(normalizeConditions(bad), [])
    }
})

test('referenced symbols are upper-cased, de-duplicated and capped', () => {
    assert.deepEqual(normalizeSymbols(['smh', 'SMH', ' qqq ']), ['SMH', 'QQQ'])
    assert.equal(normalizeSymbols(['a', 'b', 'c', 'd', 'e', 'f', 'g']).length, 6)
    assert.deepEqual(normalizeSymbols('SMH'), [])
})

// ─── validity ─────────────────────────────────────────────────────────────────

test('validity sorts flipped edges and defaults on_break to revise', () => {
    const v = normalizeValidity({ lower: 244, upper: 234 })
    assert.equal(v.lower, 234)
    assert.equal(v.upper, 244)
    assert.equal(v.on_break, 'revise')
    assert.equal(normalizeValidity({ lower: 1, upper: 2, on_break: 'close' }).on_break, 'close')
    assert.equal(normalizeValidity({ lower: 1, upper: 2, on_break: 'burn it' }).on_break, 'revise')
})

test('validity with no usable edge is null — an absent range, not a broken one', () => {
    for (const bad of [null, undefined, {}, [], { lower: 'x' }, 'wide']) {
        assert.equal(normalizeValidity(bad), null)
    }
    assert.equal(normalizeValidity({ lower: 234 }).upper, null, 'one edge is still a range')
})

// ─── validity coherence ───────────────────────────────────────────────────────
// A range that contradicts the plan is worse than no range: it reports "still valid" at a price
// where the setup's own stop is already blown.

const COHERENT = {
    direction: 'long',
    stop_zones: [{ lower: 234.8, upper: 235.9 }],
    validity:   { lower: 235.5, upper: 244, approach: 246, on_break: 'revise' },
}

test('a coherent validity range raises no problem', () => {
    assert.deepEqual(rangeProblems(COHERENT), [])
    assert.deepEqual(rangeProblems({ direction: 'long' }), [], 'no range is not a problem')
})

test('a validity floor below the stop is refused on a long', () => {
    const p = rangeProblems({ ...COHERENT, validity: { ...COHERENT.validity, lower: 230 } })
    assert.equal(p.length, 1)
    assert.match(p[0], /floor sits below the stop/)
})

test('a validity ceiling above the stop is refused on a short', () => {
    const p = rangeProblems({
        direction: 'short',
        stop_zones: [{ lower: 244, upper: 245 }],
        validity:   { lower: 230, upper: 250, approach: 228 },
    })
    assert.equal(p.length, 1)
    assert.match(p[0], /ceiling sits above the stop/)
})

test('an away pivot inside the range can never fire, so it is refused', () => {
    const p = rangeProblems({ ...COHERENT, validity: { ...COHERENT.validity, approach: 240 } })
    assert.match(p[0], /inside the validity range/)
})

// Each range is checked against ITS OWN scenario's stop — checking the false break's floor against
// the breakout's stop would compare two different trades.
test('coherence is per scenario, and the failing one is named', () => {
    const s = normalizeSetup({
        asset: 'NVDA', direction: 'long', type: 'swing', timeframe: '1hr',
        conditions: [{ id: 'c1', text: 'SMH leading' }],
        scenarios: [
            { id: 's1', name: 'false break',
              entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
              stop_zones:  [{ lower: 234.8, upper: 235.9 }],
              validity:    { lower: 235.5, upper: 244 } },
            { id: 's2', name: 'break and go',
              entry_zones: [{ lower: 244, upper: 244.9, quantity: 60 }],
              stop_zones:  [{ lower: 241, upper: 241.8 }],
              validity:    { lower: 238, upper: 250 } },   // below ITS stop, fine against s1's
        ],
    })
    const p = validityProblems(s)
    assert.equal(p.length, 1, 's1 is coherent; only s2 is not')
    assert.match(p[0], /^break and go: /, 'the message names which premise is wrong')
    assert.match(p[0], /floor sits below the stop/)
})

test('readiness reports coherence problems separately from missing fields', () => {
    const r = setupReadiness(normalizeSetup({
        asset: 'NVDA', direction: 'long', type: 'swing',
        conditions:  [{ id: 'c1', text: 'CHoCH up on the 15m' }],
        entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
        stop_zones:  [{ lower: 234.8, upper: 235.9 }],
        tp_zones:    [{ lower: 246, upper: 247.2 }],
        validity:    { lower: 230, upper: 244 },
    }), true)
    assert.equal(r.ready, false)
    assert.deepEqual(r.missing, [], 'nothing is missing — the range is wrong, not absent')
    assert.equal(r.problems.length, 1)
})

// ─── normalizeSetup ───────────────────────────────────────────────────────────

const DRAFT = {
    asset: 'nvda', direction: 'long', type: 'swing', trade_mode: 'smc', timeframe: '1hr',
    thesis: 'Sweep and reclaim of the shelf.',
    conditions: [{ id: 'c1', text: 'CHoCH up on the 15m', weight: 'primary' }],
    entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
    stop_zones:  [{ lower: 234.8, upper: 235.9, quantity: 100 }],
    tp_zones:    [{ lower: 246.0, upper: 247.2, quantity: 100 }],
    valid_until: '2026-08-08T20:00:00Z',
}

test('a well-formed draft normalises and derives its server-owned fields', () => {
    const s = normalizeSetup(DRAFT)
    assert.equal(s.asset, 'NVDA')
    assert.equal(s.quantity, 100)
    assert.deepEqual(s.ladder, buildLadder('1hr'))
    assert.deepEqual(s.cadence, buildCadence('swing'))
})

test('server-derived fields overwrite anything the model tried to author', () => {
    const s = normalizeSetup({ ...DRAFT, quantity: 9999, ladder: ['month'], cadence: { min: 1, max: 2 } })
    assert.equal(s.quantity, 100, 'quantity comes from the entry zones')
    assert.deepEqual(s.ladder, buildLadder('1hr'))
    assert.deepEqual(s.cadence, buildCadence('swing'))
})

test('an invalid enum falls back rather than reaching the monitor', () => {
    const s = normalizeSetup({ ...DRAFT, direction: 'sideways', type: 'scalp', trade_mode: 'astrology', timeframe: 'fortnight' })
    assert.equal(s.direction, null)
    assert.equal(s.type, null)
    assert.equal(s.trade_mode, 'discretionary', 'unknown lens → the default lens')
    assert.equal(s.timeframe, null)
})

test('a garbage date can never become a live time gate', () => {
    const s = normalizeSetup({ ...DRAFT, active_from: 'next tuesday-ish', valid_until: '' })
    assert.equal(s.active_from, null)
    assert.equal(s.valid_until, null)
})

test('dates normalise to Z-ISO so the poll loop can compare them lexicographically', () => {
    assert.equal(normalizeSetup({ ...DRAFT, valid_until: '2026-08-08T22:00:00+02:00' }).valid_until,
        '2026-08-08T20:00:00.000Z')
})

test('a half-built setup normalises without throwing — it renders every turn', () => {
    const s = normalizeSetup({ asset: 'AAPL' })
    assert.equal(s.asset, 'AAPL')
    assert.deepEqual(s.entry_zones, [])
    assert.equal(s.quantity, null)
    assert.equal(normalizeSetup(null), null)
    assert.equal(normalizeSetup([]), null)
})

// ─── Readiness ────────────────────────────────────────────────────────────────

test('a complete setup with a marked account is ready', () => {
    assert.deepEqual(setupReadiness(normalizeSetup(DRAFT), true), { ready: true, missing: [], problems: [] })
})

test('readiness names what is missing, so the UI never shows a dead button', () => {
    const { ready, missing } = setupReadiness(normalizeSetup(DRAFT), false)
    assert.equal(ready, false)
    assert.deepEqual(missing, ['trading account'])
})

test('a setup with no stop zone is never ready', () => {
    const { ready, missing } = setupReadiness(normalizeSetup({ ...DRAFT, stop_zones: [] }), true)
    assert.equal(ready, false)
    assert.ok(missing.includes('stop zone'))
})

test('an unsized setup is never ready', () => {
    const s = normalizeSetup({ ...DRAFT, entry_zones: [{ lower: 237.8, upper: 238.6 }] })
    assert.ok(setupReadiness(s, true).missing.includes('quantity'))
})

// ─── rr ───────────────────────────────────────────────────────────────────────

test('planned rr is measured from the WORST entry edge, never the midpoint', () => {
    // long: worst fill 238.6, stop 234.8 → risk 3.8; target 246.0 → reward 7.4 ⇒ 1.95
    assert.equal(computeRR(normalizeSetup(DRAFT)), 1.95)
})

test('the worst-edge rule is strictly more pessimistic than the midpoint', () => {
    const s = normalizeSetup(DRAFT)
    const mid = computeRR(s, (s.entry_zones[0].lower + s.entry_zones[0].upper) / 2)
    assert.ok(computeRR(s) < mid, 'the plan must not flatter itself')
})

test('rr mirrors for a short', () => {
    const short = normalizeSetup({
        ...DRAFT, direction: 'short',
        entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
        stop_zones:  [{ lower: 241.0, upper: 242.0, quantity: 100 }],
        tp_zones:    [{ lower: 230.0, upper: 231.0, quantity: 100 }],
    })
    // worst fill 237.8, stop 242.0 → risk 4.2; target 231.0 → reward 6.8 ⇒ 1.62
    assert.equal(computeRR(short), 1.62)
})

test('live rr overrides the zone edge with the actual fill', () => {
    const s = normalizeSetup(DRAFT)
    // Entering at the good edge is a better trade than the plan advertised.
    assert.ok(computeRR(s, 237.8) > computeRR(s))
})

test('rr picks the NEAREST target and the WIDEST stop, whatever order they were emitted in', () => {
    // The model reasons about targets in narrative order, not price order. Indexing [0] would
    // hand this setup the rr of its far target and overstate the trade.
    const jumbled = normalizeSetup({
        ...DRAFT,
        tp_zones:   [{ lower: 260, upper: 261, quantity: 50 }, { lower: 246, upper: 247.2, quantity: 50 }],
        stop_zones: [{ lower: 236, upper: 236.5 }, { lower: 234.8, upper: 235.9 }],
    })
    // nearest tp 246, widest stop 234.8, worst entry 238.6 → identical to the single-leg case.
    assert.equal(computeRR(jumbled), 1.95)
})

// ─── stopEdge / targetEdges — the levels the in-position gate measures against ──
// Both are selected BY PRICE, never by array position. The model emits zones in the order it
// reasoned about them, so `[0]` is a coin flip: it would hand the gate the near stop instead of the
// working one, and fire a partial ladder in whatever order the sentences came out.

test('stopEdge takes the WIDEST edge — the most risk the plan actually admits', () => {
    const long = normalizeSetup({
        ...DRAFT,
        stop_zones: [{ lower: 236, upper: 236.5 }, { lower: 234.8, upper: 235.9 }],
    })
    assert.equal(stopEdge(long), 234.8, 'the far edge of the far zone, not stop_zones[0]')

    // Mirrored on a short: widest means the HIGHEST edge, because that is where the risk ends.
    const short = normalizeSetup({ ...DRAFT, direction: 'short',
        entry_zones: [{ lower: 238, upper: 238.6, quantity: 100 }],
        stop_zones:  [{ lower: 240, upper: 240.5 }, { lower: 241, upper: 242.2 }],
        tp_zones:    [{ lower: 230, upper: 231, quantity: 100 }],
    })
    assert.equal(stopEdge(short), 242.2)
})

test('stopEdge is null when nothing is authored, rather than 0', () => {
    // A 0 here would read as "the stop is at zero", i.e. infinite risk on a long — and the gate
    // would then never see price press it.
    assert.equal(stopEdge(normalizeSetup({ ...DRAFT, stop_zones: [] })), null)
    assert.equal(stopEdge(null), null)
})

test('targetEdges come back NEAREST-FIRST — the order price reaches them', () => {
    // That is also the order a partial ladder must fire in. Array order would take the far leg first.
    const long = normalizeSetup({
        ...DRAFT,
        tp_zones: [{ lower: 260, upper: 261, quantity: 50 }, { lower: 246, upper: 247.2, quantity: 50 }],
    })
    assert.deepEqual(targetEdges(long), [246, 260], 'nearest first, despite being emitted second')

    const short = normalizeSetup({ ...DRAFT, direction: 'short',
        entry_zones: [{ lower: 238, upper: 238.6, quantity: 100 }],
        stop_zones:  [{ lower: 241, upper: 242 }],
        tp_zones:    [{ lower: 220, upper: 221, quantity: 50 }, { lower: 232, upper: 233, quantity: 50 }],
    })
    assert.deepEqual(targetEdges(short), [233, 221], 'a short reaches the HIGHEST target first')
})

test('targetLevels reads a tp zone as the price the limit rests at', () => {
    // A level authored today is zero-width, so this is simply "the target". On a LEGACY band it is
    // the far side — the level such a document was already resting at, so a deploy moves nothing.
    const long = normalizeSetup({ ...DRAFT, direction: 'long',
        tp_zones: [{ price: 260 }, { price: 245 }] })
    assert.deepEqual(long.scenarios[0].tp_zones.map(z => [z.lower, z.upper]), [[260, 260], [245, 245]],
        'a bare price collapses to a zero-width level')
    assert.deepEqual(targetLevels(long).map(t => t.target), [245, 260], 'nearest-first')

    const short = normalizeSetup({ ...DRAFT, direction: 'short', tp_zones: [{ price: 220 }, { price: 232 }] })
    assert.deepEqual(targetLevels(short).map(t => t.target), [232, 220], 'a short reaches the HIGHEST target first')

    const legacy = normalizeSetup({ ...DRAFT, direction: 'long', tp_zones: [{ lower: 258, upper: 260 }] })
    assert.deepEqual(targetLevels(legacy).map(t => t.target), [260], 'a legacy band rests at the far side')
})

test('a target carries its own conditions, in the same shape an entry condition has', () => {
    // The whole reason there is no exit evaluator: an exit condition is a SENTENCE the model judges,
    // not a tree software resolves. Same normaliser, same three axes, same document-wide id space.
    const s = normalizeSetup({ ...DRAFT, direction: 'long',
        tp_zones: [{ price: 260, conditions: [{ text: 'only if volume confirms the push', weight: 'primary' }] }] })
    const [tp] = s.scenarios[0].tp_zones
    assert.equal(tp.conditions.length, 1)
    assert.equal(tp.conditions[0].text, 'only if volume confirms the push')
    assert.equal(tp.conditions[0].weight, 'primary')
    assert.equal(tp.conditions[0].mode, 'judgment', 'unstamped defaults exactly as a scenario condition does')
    assert.equal(tp.conditions[0].persistence, 'live')
    assert.deepEqual(targetLevels(s)[0].conditions, tp.conditions, 'and it rides out with the level')
})

test('a leg condition claims its id from the DOCUMENT-WIDE set, not its own list', () => {
    // `monitor_state.conditions` is ONE latch map for the setup. A target's condition sharing an id
    // with a scenario's would let one latch answer for the other.
    const s = normalizeSetup({ ...DRAFT, direction: 'long',
        conditions: [{ id: 'x1', text: 'regime is risk-on' }],
        tp_zones:   [{ price: 260, conditions: [{ id: 'x1', text: 'volume confirms' }] }],
        stop_zones: [{ price: 234, conditions: [{ id: 'x1', text: 'closes below the 4hr VWAP' }] }],
    })
    const ids = [
        ...s.conditions.map(c => c.id),
        ...s.scenarios[0].tp_zones.flatMap(z => z.conditions.map(c => c.id)),
        ...s.scenarios[0].stop_zones.flatMap(z => z.conditions.map(c => c.id)),
    ]
    assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids.join(', ')}`)
})

test('a zero-width tp zone is a level with nothing to discuss', () => {
    const s = normalizeSetup({ ...DRAFT, direction: 'long', tp_zones: [{ lower: 246, upper: 246 }] })
    assert.deepEqual(targetLevels(s), [{ target: 246, conditions: [] }])
})

test('a setup cannot be generated without a target PRICE', () => {
    // The far edge of a tp band is the limit that rests at the broker. A premise without one is a
    // position that can only be closed by its stop, by hand, or by Talos noticing — half a plan.
    const base = {
        asset: 'NVDA', direction: 'long', type: 'swing',
        conditions:  [{ id: 'c1', text: 'CHoCH up on the 15m' }],
        entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
        stop_zones:  [{ lower: 234.8, upper: 235.9 }],
    }
    assert.match(setupReadiness(normalizeSetup(base), true).missing.join(' '), /target price/)

    // A band of nulls is a zone to the array and no price to the broker.
    const blank = setupReadiness(normalizeSetup({ ...base, tp_zones: [{ lower: null, upper: null }] }), true)
    assert.match(blank.missing.join(' '), /target price/)

    const ok = setupReadiness(normalizeSetup({ ...base, tp_zones: [{ lower: 246, upper: 247.2 }] }), true)
    assert.deepEqual(ok.missing, [])
    assert.equal(ok.ready, true)
})

test('a missing target names WHICH premise is short of one', () => {
    const two = normalizeSetup({
        asset: 'NVDA', direction: 'long', type: 'swing',
        conditions: [{ id: 'c1', text: 'SMH leading' }],
        scenarios: [
            { id: 's1', name: 'false break', entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
              stop_zones: [{ lower: 234.8, upper: 235.9 }], tp_zones: [{ lower: 246, upper: 247.2 }] },
            { id: 's2', name: 'break and go', entry_zones: [{ lower: 244, upper: 244.9, quantity: 60 }],
              stop_zones: [{ lower: 241, upper: 241.8 }] },
        ],
    })
    assert.deepEqual(setupReadiness(two, true).missing, ['target price on break and go'])
})

test('targetEdges is empty, never [null], when none is authored', () => {
    // The fill path maps this into position_state.targets — a null in there would become a target
    // the gate compares price against forever.
    assert.deepEqual(targetEdges(normalizeSetup({ ...DRAFT, tp_zones: [] })), [])
    assert.deepEqual(targetEdges(null), [])
})

test('rr is null when a leg is missing or the entry sits inside its own stop', () => {
    assert.equal(computeRR(normalizeSetup({ ...DRAFT, tp_zones: [] })), null)
    assert.equal(computeRR(normalizeSetup({ ...DRAFT, stop_zones: [{ lower: 239, upper: 240 }] })), null)
})

// ─── scenarios ────────────────────────────────────────────────────────────────
// A price zone is a scenario: a premise that owns its entry, its stop, its targets, its conditions
// and its death line. Rivals, not legs — the first to fulfil takes the whole trade.

const RIVALS = {
    asset: 'NVDA', direction: 'long', type: 'swing', timeframe: '1hr',
    thesis: 'Two ways into the same idea.',
    conditions: [{ id: 'c1', text: 'SMH leading, not diverging', weight: 'confirming' }],
    scenarios: [
        { id: 's1', name: 'false break',
          conditions:  [{ text: 'sweep of 238 that closes back inside', weight: 'primary', mode: 'measured' }],
          entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
          stop_zones:  [{ lower: 234.8, upper: 235.9 }],
          tp_zones:    [{ lower: 246.0, upper: 247.2 }] },
        { id: 's2', name: 'break and go',
          conditions:  [{ text: '1hr close above 244 on volume', weight: 'primary', mode: 'measured' }],
          entry_zones: [{ lower: 244.0, upper: 244.9, quantity: 60 }],
          stop_zones:  [{ lower: 241.0, upper: 241.8 }],
          tp_zones:    [{ lower: 252.0, upper: 253.5 }] },
    ],
}

test('each scenario keeps its own legs, size and r:r', () => {
    const s = normalizeSetup(RIVALS)
    assert.equal(s.scenarios.length, 2)
    assert.equal(s.scenarios[0].quantity, 100)
    assert.equal(s.scenarios[1].quantity, 60)
    // Priced from its OWN legs: s1 worst fill 238.6 / stop 234.8 / tp 246 ⇒ 1.95.
    assert.equal(s.scenarios[0].rr, 1.95)
    assert.notEqual(s.scenarios[1].rr, s.scenarios[0].rr)
})

test('QUANTITY IS NEVER SUMMED ACROSS SCENARIOS — the whole trade, whichever prints', () => {
    const s = normalizeSetup(RIVALS)
    assert.equal(s.quantity, 100, 'the projected scenario, not 160')
    assert.equal(projectScenario(s, 's2').quantity, 60)
})

test('the document projects ONE scenario for execution — the armed one, else the first', () => {
    const s = normalizeSetup(RIVALS)
    assert.deepEqual(s.entry_zones, s.scenarios[0].entry_zones, 'pre-arm: the primary')
    assert.deepEqual(s.stop_zones,  s.scenarios[0].stop_zones)
    assert.equal(s.rr, s.scenarios[0].rr)

    const armed = normalizeSetup({ ...RIVALS, armed_scenario_id: 's2' })
    assert.deepEqual(armed.entry_zones, armed.scenarios[1].entry_zones)
    assert.deepEqual(armed.tp_zones,    armed.scenarios[1].tp_zones)
})

test('condition ids are unique across the WHOLE document — one ledger, one key each', () => {
    const s = normalizeSetup({
        ...RIVALS,
        conditions: [{ id: 'c1', text: 'root one' }],
        scenarios: RIVALS.scenarios.map(sc => ({ ...sc, conditions: [{ id: 'c1', text: 'scenario one' }] })),
    })
    const ids = [s.conditions[0].id, ...s.scenarios.flatMap(sc => sc.conditions.map(c => c.id))]
    assert.equal(new Set(ids).size, ids.length, 'a collision would let one latch answer for another')
})

test('an unnamed scenario condition is keyed by its scenario, so it reads back', () => {
    const s = normalizeSetup(RIVALS)
    assert.equal(s.scenarios[1].conditions[0].id, 's2c1')
})

test('a wake judges root ∪ the armed scenario, never the rival', () => {
    const s = normalizeSetup(RIVALS)
    const declared = declaredConditions(s, s.scenarios[0])
    assert.deepEqual(declared.map(c => c.text), ['SMH leading, not diverging', 'sweep of 238 that closes back inside'])
    assert.deepEqual(declaredConditions(s, null).map(c => c.id), ['c1'], 'no scenario → the root tier alone')
})

test('a scenario view is what the per-plan helpers take — direction rides down from the setup', () => {
    const s = normalizeSetup(RIVALS)
    assert.equal(scenarioView(s, s.scenarios[1]).direction, 'long')
    assert.equal(scenarioLabel(s.scenarios[1]), 'break and go')
    assert.equal(scenarioLabel({ id: 's3' }), 's3', 'no name → the id, never blank')
})

test('pickScenario falls back to the first when the id is unknown or absent', () => {
    const s = normalizeSetup(RIVALS)
    assert.equal(pickScenario(s, 'nope').id, 's1')
    assert.equal(pickScenario(s).id, 's1')
    assert.equal(pickScenario({ scenarios: [] }), null)
})

test('scenario ids collide safely rather than merging two premises', () => {
    const list = normalizeScenarios([{ id: 's1' }, { id: 's1' }], { direction: 'long' })
    assert.deepEqual(list.map(s => s.id), ['s1', 's1_2'])
})

// ─── readiness, per scenario ──────────────────────────────────────────────────

test('readiness names WHICH premise is unfinished', () => {
    const s = normalizeSetup({ ...RIVALS, scenarios: [RIVALS.scenarios[0], { ...RIVALS.scenarios[1], stop_zones: [] }] })
    const { ready, missing } = setupReadiness(s, true)
    assert.equal(ready, false)
    assert.deepEqual(missing, ['stop zone on break and go'])
})

test('a scenario with no trigger of its own is fine while the root carries one', () => {
    const s = normalizeSetup({ ...RIVALS, scenarios: RIVALS.scenarios.map(sc => ({ ...sc, conditions: [] })) })
    assert.equal(setupReadiness(s, true).ready, true)
})

test('a scenario with nothing to check anywhere arms blind, and is refused', () => {
    const s = normalizeSetup({ ...RIVALS, conditions: [], scenarios: RIVALS.scenarios.map(sc => ({ ...sc, conditions: [] })) })
    assert.ok(setupReadiness(s, true).missing.includes('condition on false break'))
})

test('a limit setup with no conditions is ready — the price touch IS the trigger', () => {
    const s = normalizeSetup({
        asset: 'NVDA', direction: 'long', type: 'swing',
        entry_mode: 'limit',
        entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
        stop_zones:  [{ lower: 234.8, upper: 235.9 }],
        tp_zones:    [{ lower: 246, upper: 247.2 }],
    })
    const { missing } = setupReadiness(s, true)
    assert.ok(!missing.some(m => m.includes('condition')), `condition must not be required for limit setups; got: ${missing.join(', ')}`)
})

test('two entries in ONE scenario is scaling in — allowed, once every leg carries a size', () => {
    // The block this replaces refused a second leg outright, because execution placed the premise's
    // whole size on the first print. It places the LEG's size now, so the rule narrows to the thing
    // that still has to hold.
    const s = normalizeSetup({ ...RIVALS, scenarios: [{
        ...RIVALS.scenarios[0],
        entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 60 }, { lower: 236.2, upper: 236.8, quantity: 40 }],
    }, RIVALS.scenarios[1]] })
    assert.deepEqual(setupReadiness(s, true).missing, [])
})

test('a scale-in leg with no size of its own is refused', () => {
    // A sized leg falls back to the premise total, so an unsized second leg would place the WHOLE
    // position on the first print — exactly the failure the old blanket block existed to prevent.
    const s = normalizeSetup({ ...RIVALS, scenarios: [{
        ...RIVALS.scenarios[0],
        entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 60 }, { lower: 236.2, upper: 236.8 }],
    }, RIVALS.scenarios[1]] })
    assert.match(setupReadiness(s, true).missing.join(' '), /size on every entry leg/)
})

test('a leg drawn PAST the stop is refused — price could never reach it', () => {
    // Found while writing scale-in fixtures: a second leg under the stop made every gate report
    // `adverse`, correctly. It reads like a plan to add twice and can only ever add once.
    const s = normalizeSetup({ ...RIVALS, scenarios: [{
        ...RIVALS.scenarios[0],
        stop_zones:  [{ lower: 234.8, upper: 235.9 }],
        entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 60 }, { lower: 231, upper: 232, quantity: 40 }],
    }, RIVALS.scenarios[1]] })
    assert.match(setupReadiness(s, true).problems.join(' '), /past the stop/)
})

test('a setup with no scenario at all is not a plan', () => {
    assert.ok(setupReadiness(normalizeSetup({ asset: 'NVDA', direction: 'long', type: 'swing' }), true).missing.includes('scenario'))
})

// ─── the legacy wrap ──────────────────────────────────────────────────────────

test('a pre-scenario document becomes exactly one scenario, keeping its zone ids', () => {
    const s = normalizeSetup({ ...DRAFT, validity: { lower: 234, upper: 244, on_break: 'close' } })
    assert.equal(s.scenarios.length, 1)
    assert.equal(s.scenarios[0].id, 's1')
    assert.deepEqual(s.scenarios[0].entry_zones, s.entry_zones, 'the projection matches the wrap')
    assert.equal(s.scenarios[0].validity.on_break, 'close', 'the root range moves down with it')
    assert.equal(s.validity.on_break, 'close', 'and is projected back up for the FE')
})

test('re-normalising an already-scenario document is idempotent', () => {
    const once  = normalizeSetup(RIVALS)
    const twice = normalizeSetup(once)
    assert.deepEqual(twice.scenarios, once.scenarios)
    assert.deepEqual(twice.entry_zones, once.entry_zones)
})

// `Number(null)` is 0, and this module re-normalises its OWN output — every streamed turn, every
// edit, every Generate — where an absent edge is written as `null`, not `undefined`. So an absent
// away pivot became a pivot at 0 on the second pass, which for a long reads as "price ran away
// above 0": permanently true, refused by the coherence check, and a runaway alert on every wake.
// A live verification run refused to Generate a plan with nothing wrong with it.
test('AN ABSENT EDGE STAYS ABSENT through a second normalise — Number(null) is 0', () => {
    // 235 sits at/above DRAFT's stop far edge (234.8), so the only thing that can be reported here
    // is the phantom pivot.
    const once  = normalizeSetup({ ...DRAFT, validity: { lower: 235, upper: 244 } })
    assert.equal(once.validity.approach, null)

    const twice = normalizeSetup(once)
    assert.equal(twice.validity.approach, null, 'a pivot the author never wrote must not appear at 0')
    assert.deepEqual(validityProblems(twice), [], 'and must not be reported as incoherent')
})

test('an absent validity floor does not become a floor of 0', () => {
    // Same trap, other edge: 0 is below every stop, so this refused Generate with "floor sits below
    // the stop" on a range whose floor was simply never authored.
    const once  = normalizeSetup({ ...DRAFT, validity: { upper: 244, approach: 246 } })
    const twice = normalizeSetup(once)
    assert.equal(twice.validity.lower, null)
    assert.deepEqual(validityProblems(twice), [])
})

test('an unsized zone does not become a zone at 0 on the second pass', () => {
    const once  = normalizeZone({ lower: null, upper: 238.6, quantity: null }, 0, 'ez')
    const twice = normalizeZone(once, 0, 'ez')
    assert.deepEqual([twice.lower, twice.upper], [238.6, 238.6], 'a one-edged band stays that level')
    assert.equal(twice.quantity, null)
})

// ─── plan edges: chosen by PRICE, never by array position ─────────────────────
// The model emits zones in whatever order it reasoned about them. computeRR already depended on
// this rule; the position gate now does too, so it lives in one place rather than being re-derived
// by every caller that needs "which stop am I actually working against".

test('the working stop is the WIDEST edge, whatever order the zones arrived in', () => {
    // Widest = most risk the plan admits. Taking the nearest would understate risk and overstate R.
    const long = { direction: 'long', stop_zones: [{ lower: 96, upper: 97 }, { lower: 94, upper: 95 }] }
    assert.equal(stopEdge(long), 94)

    const short = { direction: 'short', stop_zones: [{ lower: 103, upper: 104 }, { lower: 105, upper: 106 }] }
    assert.equal(stopEdge(short), 106, 'a short works against the HIGH edge')
})

test('a long and a short read opposite edges of the same band', () => {
    // The band is where price ARRIVES: a long is stopped at the low side, a short at the high side.
    const zones = [{ lower: 94, upper: 95 }]
    assert.equal(stopEdge({ direction: 'long',  stop_zones: zones }), 94)
    assert.equal(stopEdge({ direction: 'short', stop_zones: zones }), 95)
})

test('targets come back nearest-first, which is the order partials fire in', () => {
    const long = { direction: 'long', tp_zones: [{ lower: 120, upper: 121 }, { lower: 105, upper: 106 }] }
    assert.deepEqual(targetEdges(long), [105, 120], 'authored far-then-near, returned near-then-far')

    const short = { direction: 'short', tp_zones: [{ lower: 80, upper: 81 }, { lower: 95, upper: 96 }] }
    assert.deepEqual(targetEdges(short), [96, 81], 'a short falls INTO its targets')
})

test('no zones authored → null stop and an empty ladder, never a thrown or a NaN', () => {
    assert.equal(stopEdge({ direction: 'long' }), null)
    assert.equal(stopEdge(null), null)
    assert.deepEqual(targetEdges({ direction: 'long' }), [])
    assert.deepEqual(targetEdges(null), [])
})

test('an unusable edge is skipped rather than poisoning the selection', () => {
    // One malformed zone must not make Math.min return NaN and take the whole gate down with it.
    const s = { direction: 'long', stop_zones: [{ lower: null, upper: 97 }, { lower: 94, upper: 95 }] }
    assert.equal(stopEdge(s), 94)
})

test('computeRR still quotes the widest stop against the nearest target', () => {
    // The extraction must not change the number: rr is what the plan advertises to the user.
    const setup = {
        direction: 'long',
        entry_zones: [{ lower: 99, upper: 100 }],
        stop_zones:  [{ lower: 96, upper: 97 }, { lower: 94, upper: 95 }],   // widest = 94 → risk 6
        tp_zones:    [{ lower: 120, upper: 121 }, { lower: 106, upper: 107 }], // nearest = 106 → reward 6
    }
    assert.equal(computeRR(setup), 1)
})

// ─── Entry legs — the arithmetic scaling in rests on ──────────────────────────
// A scaled position is several fills at different prices, so `entry` becomes an aggregate. This
// lands BEFORE per-leg execution because everything downstream measures from `fill_price`:
// rMultiple feeds positionGate's adverse and breakeven tiers and computeMetrics' mae/mfe, so an
// average that is wrong misreports R on every wake of every scaled position.

test('one leg is the average of one — today\'s behaviour, unchanged', () => {
    // The whole reason this is safe to ship before the rest of scaling in.
    const e = addEntryLeg(null, { price: 238.6, quantity: 100 })
    assert.equal(e.fill_price, 238.6)
    assert.equal(e.size, 100)
    assert.equal(e.legs.length, 1)
})

test('two legs weight by SIZE, not by count', () => {
    // 100 @ 100 then 300 @ 108 is 106, not 104. A plain mean flatters a position that added into
    // strength and would report it a full R nearer its stop than it is.
    const e = addEntryLeg(addEntryLeg(null, { price: 100, quantity: 100 }), { price: 108, quantity: 300 })
    assert.equal(e.fill_price, 106)
    assert.equal(e.size, 400)
    assert.equal(e.legs.length, 2)
})

test('legs accumulate in fill order and keep what they were', () => {
    // The average is derived; the legs are the record. A user asking "where did I get in" wants both.
    const e = addEntryLeg(addEntryLeg(null,
        { zone_id: 'ez1', price: 50, quantity: 10 }), { zone_id: 'ez2', price: 60, quantity: 10 })
    assert.deepEqual(e.legs.map(l => l.zone_id), ['ez1', 'ez2'])
    assert.equal(e.fill_price, 55)
})

test('an unsized leg falls back to the last price rather than to NaN', () => {
    // The single-leg path has always written a price with no quantity when sizing was unresolved.
    // It must keep working, not divide by zero.
    const e = addEntryLeg(null, { price: 238.6 })
    assert.equal(e.fill_price, 238.6)
    assert.equal(e.size, null)
})

test('a priceless leg still counts toward SIZE, but never toward the average', () => {
    // Two separate facts. Number(null) is 0, not NaN, so an unpriced leg left in the weighting
    // enters as a free share and halves the reported entry — every R after that is wrong.
    // But it still filled: dropping its quantity would under-report the position, and a stop sized
    // to less than is held is the more dangerous error of the two.
    const e = addEntryLeg(addEntryLeg(null, { price: 100, quantity: 10 }), { price: null, quantity: 10 })
    assert.equal(e.fill_price, 100, 'the unpriced leg does not drag the average to 50')
    assert.equal(e.size, 20, 'but the position really is 20')
    assert.equal(e.legs.length, 2, 'and both fills are on the record')
})

test('a leg with size but no price anywhere leaves the price unknown, not zero', () => {
    const e = addEntryLeg(null, { price: null, quantity: 10 })
    assert.equal(e.fill_price, null)
    assert.equal(e.size, 10)
})

test('the average is rounded, so a third of a cent never reaches a card', () => {
    const e = addEntryLeg(addEntryLeg(null, { price: 10, quantity: 1 }), { price: 11, quantity: 2 })
    assert.equal(e.fill_price, 10.666667)
})

// ─── Per-leg sizing ───────────────────────────────────────────────────────────
// Execution projects a scenario's WHOLE size onto the flat quantity field. Right for one leg,
// wrong for two: the first zone to print would place the size of both, putting the position fully
// on with half the plan confirmed — and sizing the protective orders to match.

test('a leg is sized by its own zone', () => {
    const sc = { entry_zones: [{ id: 'ez1', quantity: 60 }, { id: 'ez2', quantity: 40 }] }
    assert.equal(legQuantity(sc, 'ez1'), 60)
    assert.equal(legQuantity(sc, 'ez2'), 40)
})

test('with ONE entry zone the leg and the premise agree — which is why this is inert today', () => {
    // scenarioQuantity of a single zone IS that zone's quantity, so nothing changes until a
    // premise actually has two legs.
    const sc = { entry_zones: [{ id: 'ez1', quantity: 100 }] }
    assert.equal(legQuantity(sc, 'ez1'), scenarioQuantity(sc.entry_zones))
})

test('an unsized or unknown zone yields null, so the caller falls back to the premise total', () => {
    // Never 0 — a zero would place nothing and read as a successful entry.
    assert.equal(legQuantity({ entry_zones: [{ id: 'ez1' }] }, 'ez1'), null)
    assert.equal(legQuantity({ entry_zones: [{ id: 'ez1', quantity: 0 }] }, 'ez1'), null)
    assert.equal(legQuantity({ entry_zones: [{ id: 'ez1', quantity: 10 }] }, 'nope'), null)
    assert.equal(legQuantity(null, 'ez1'), null)
})

test('legs never sum across a premise at execution time', () => {
    // The safety property, from the other side: two legs of 60 and 40 must place 60, not 100.
    const sc = { entry_zones: [{ id: 'ez1', quantity: 60 }, { id: 'ez2', quantity: 40 }] }
    assert.equal(scenarioQuantity(sc.entry_zones), 100, 'the premise is 100 in total')
    assert.notEqual(legQuantity(sc, 'ez1'), 100, 'but the first print is not')
})

// ─── Pending legs, and when adding is allowed ─────────────────────────────────

const TWO_LEG = { entry_zones: [{ id: 'ez1', lower: 100, upper: 101, quantity: 60 },
                                { id: 'ez2', lower: 95,  upper: 96,  quantity: 40 }] }

test('a filled leg drops out, and the rest stay pending', () => {
    const pend = pendingLegs(TWO_LEG, { legs: [{ zone_id: 'ez1' }] })
    assert.deepEqual(pend.map(z => z.id), ['ez2'])
})

test('legs are matched by ID, not by count — they fill in whatever order price reaches them', () => {
    // A dip leg and a reclaim leg fill in the order the market offers, not the order authored.
    const pend = pendingLegs(TWO_LEG, { legs: [{ zone_id: 'ez2' }] })
    assert.deepEqual(pend.map(z => z.id), ['ez1'], 'the SECOND authored leg filled first')
})

test('a single-leg premise has nothing pending once it fills — the whole path stays inert today', () => {
    const one = { entry_zones: [{ id: 'ez1', quantity: 100 }] }
    assert.equal(pendingLegs(one, { legs: [{ zone_id: 'ez1' }] }).length, 0)
})

test('an unfilled premise is entirely pending, and a missing scenario is not a crash', () => {
    assert.equal(pendingLegs(TWO_LEG, null).length, 2)
    assert.equal(pendingLegs(TWO_LEG, { legs: [] }).length, 2)
    assert.equal(pendingLegs(null, { legs: [] }).length, 0)
})

test('NEVER add to a position that is pressing its stop', () => {
    // The averaging-down reflex is the one thing this feature must not automate: it turns one
    // planned loss into a larger unplanned one.
    assert.equal(mayScaleIn('adverse'), false)
})

test('a position doing well may still take its planned leg', () => {
    // scale_out and breakeven mean the trade is working — exactly when a second planned leg is
    // legitimate. Blocking on any flag at all would make the feature unreachable in practice.
    assert.equal(mayScaleIn('scale_out'), true)
    assert.equal(mayScaleIn('breakeven'), true)
    assert.equal(mayScaleIn(null), true)
})

// ─── The condition-mode rename ────────────────────────────────────────────────
// `discretionary` moved to `judgment` because the LENS set becomes
// discretionary|smc|institutional, and one document carrying `mode` for both meanings is a trap.

test('a setup stored before the rename still reads as judgment, not as garbage', () => {
    // The migration, and the whole reason it costs nothing: 'discretionary' is no longer in the set,
    // so it falls to the default — which IS 'judgment'. Same meaning, new name, no rewrite.
    const [c] = normalizeConditions([{ text: 'weak here', mode: 'discretionary' }])
    assert.equal(c.mode, 'judgment')
})

test('measured still survives a re-normalise untouched', () => {
    // The half that must NOT move: a named test is a different claim about how checkable the
    // condition is, and silently downgrading it would overstate the monitor's freedom.
    const [c] = normalizeConditions([{ text: 'below VWAP', mode: 'measured' }])
    assert.equal(c.mode, 'measured')
})

test('the lens vocabulary and the condition vocabulary no longer share a word', () => {
    // The point of the rename, stated as an invariant so it cannot quietly regress when the lens
    // set grows to three.
    const overlap = CONDITION_MODES.filter(m => MODES.includes(m))
    assert.deepEqual(overlap, [], `"${overlap}" means two unrelated things`)
})

// ─── The three lenses ─────────────────────────────────────────────────────────
// Mentor now offers the same three Kairos does, so a user hears one vocabulary across both desks.

test('a setup built before the rename keeps its lens, under the new name', () => {
    // `classical` meant exactly what `discretionary` means. It is no longer in the set, so it falls
    // to the default — which IS `discretionary`. Same migration-for-free as the condition rename.
    assert.equal(normalizeSetup({ ...DRAFT, trade_mode: 'classical' }).trade_mode, 'discretionary')
})

test('institutional is a real lens, not coerced away', () => {
    assert.equal(normalizeSetup({ ...DRAFT, trade_mode: 'institutional' }).trade_mode, 'institutional')
    assert.equal(normalizeSetup({ ...DRAFT, trade_mode: 'smc' }).trade_mode, 'smc')
})

test('Mentor and Kairos offer the SAME three lenses', () => {
    // The point of the change. Two desks describing one concept with different words is how a user
    // ends up thinking they are different concepts.
    assert.deepEqual([...TRADE_MODES].sort(), [...MODES].sort())
})

// ─── Guards: the model asks, the server decides ───────────────────────────────
// docs/desks/talos-guards.md. A guard fires when EVERY term it carries holds, and `clampGuards` is
// the half of the contract that cannot be talked out of it.

const GSETUP = { cadence: { min: 5, max: 240 } }

test('a guard keeps both terms, so the conjunction survives the clamp', () => {
    const [g] = clampGuards([{ after_min: 30, price: 305, direction: 'above' }], GSETUP, 300)
    assert.deepEqual(g, { after_min: 30, price: 305, direction: 'above', means: null })
})

test('the time term is clamped to the horizon band, never refused', () => {
    // A model asking to be woken in one minute on a swing burns the budget; one asking for three
    // days goes blind. Both are honest asks made badly, so both are corrected rather than dropped.
    assert.equal(clampGuards([{ after_min: 1 }], GSETUP)[0].after_min, 5)
    assert.equal(clampGuards([{ after_min: 4320 }], GSETUP)[0].after_min, 240)
})

test('a missing direction is inferred from where price actually is', () => {
    // A level with no side is not a crossing, it is a number.
    assert.equal(clampGuards([{ price: 311.5 }], GSETUP, 305)[0].direction, 'above')
    assert.equal(clampGuards([{ price: 300 }],   GSETUP, 305)[0].direction, 'below')
})

test('an ALREADY-TRUE price guard is dropped — it would be a paid infinite loop', () => {
    // "below 305" armed while price is already 300 is satisfied the instant it is written: it wakes
    // the model, which re-arms it, which wakes the model. The backstop is what remains.
    const out = clampGuards([{ price: 305, direction: 'below' }], GSETUP, 300)
    assert.deepEqual(out.map(g => g.price), [null], 'only the injected backstop survives')
})

test('a guard with neither a time nor a price term cannot fire, so it is dropped', () => {
    const out = clampGuards([{ means: 'entry' }, { price: 'soon' }], GSETUP, 300)
    assert.equal(out.filter(g => g.price != null).length, 0)
})

test('THE BACKSTOP IS INJECTED when the read forgot one', () => {
    // Without an unconditional time guard a pure conjunction STARVES: price sits 20 away for three
    // weeks, nothing trips, nothing looks — while earnings came and went. No symptom until far too
    // late, so a forgotten backstop is repaired rather than reported.
    const out = clampGuards([{ price: 311.5, direction: 'above' }], GSETUP, 305)
    const backstop = out.find(g => g.after_min != null && g.price == null)
    assert.ok(backstop, 'a set with only price guards must gain a heartbeat')
    assert.equal(backstop.after_min, 240, 'at the lazy end of the setup\'s own band')
})

test('a backstop the model DID arm is not doubled', () => {
    const out = clampGuards([{ after_min: 60 }, { price: 311.5, direction: 'above' }], GSETUP, 305)
    assert.equal(out.filter(g => g.after_min != null && g.price == null).length, 1)
})

test('an empty or junk set still comes back with a heartbeat', () => {
    // The starvation guarantee cannot depend on the model returning anything at all.
    for (const raw of [[], null, undefined, 'nonsense', [null, 7, 'x']]) {
        const out = clampGuards(raw, GSETUP)
        assert.equal(out.length, 1, `${JSON.stringify(raw)} should yield exactly the backstop`)
        assert.equal(out[0].after_min, 240)
    }
})

test('price levels are capped, so one read cannot arm a hedge instead of a watch', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ price: 400 + i, direction: 'above' }))
    const out  = clampGuards(many, GSETUP, 300)
    assert.equal(out.filter(g => g.price != null).length, 6)
})

test('only a known MEANING survives, so a wake cannot arrive mislabelled', () => {
    assert.equal(clampGuards([{ price: 311, direction: 'above', means: 'entry' }], GSETUP, 305)[0].means, 'entry')
    assert.equal(clampGuards([{ price: 311, direction: 'above', means: 'vibes' }], GSETUP, 305)[0].means, null)
})

// ─── entry_mode ───────────────────────────────────────────────────────────────

test('entry_mode defaults to "conditional" when absent or unknown', () => {
    assert.equal(normalizeSetup({}).entry_mode, 'conditional')
    assert.equal(normalizeSetup({ entry_mode: null }).entry_mode, 'conditional')
    assert.equal(normalizeSetup({ entry_mode: 'something' }).entry_mode, 'conditional')
    assert.equal(normalizeSetup({ entry_mode: '' }).entry_mode, 'conditional')
})

test('entry_mode is "limit" only when the model explicitly says so', () => {
    assert.equal(normalizeSetup({ entry_mode: 'limit' }).entry_mode, 'limit')
})
