import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    buildLadder, buildCadence, normalizeZone, normalizeZones, totalQuantity,
    normalizeConditions, normalizeSymbols, normalizeValidity, validityProblems,
    normalizeSetup, setupReadiness, computeRR, TF_RUNGS,
} from '../../services/setup.schema.js'

// The `setup` entity contract (docs/setup-entity.md §3). Mentor authors loosely, Talos monitors
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
    assert.deepEqual(buildLadder('1min'), ['15min', '5min', '1min'])
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

test('total quantity sums the scale-in legs, and is null when nothing is sized', () => {
    assert.equal(totalQuantity([{ quantity: 100 }, { quantity: 50 }]), 150)
    assert.equal(totalQuantity([{ quantity: null }]), null)
    assert.equal(totalQuantity([]), null)
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
    // discretionary: claiming "measured" without a named test would overstate how hard the check is.
    const [c] = normalizeConditions([{ text: 'NVDA weak' }])
    assert.equal(c.persistence, 'live')
    assert.equal(c.mode, 'discretionary')
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
    assert.deepEqual(validityProblems(COHERENT), [])
    assert.deepEqual(validityProblems({ direction: 'long' }), [], 'no range is not a problem')
})

test('a validity floor below the stop is refused on a long', () => {
    const p = validityProblems({ ...COHERENT, validity: { ...COHERENT.validity, lower: 230 } })
    assert.equal(p.length, 1)
    assert.match(p[0], /floor sits below the stop/)
})

test('a validity ceiling above the stop is refused on a short', () => {
    const p = validityProblems({
        direction: 'short',
        stop_zones: [{ lower: 244, upper: 245 }],
        validity:   { lower: 230, upper: 250, approach: 228 },
    })
    assert.equal(p.length, 1)
    assert.match(p[0], /ceiling sits above the stop/)
})

test('an away pivot inside the range can never fire, so it is refused', () => {
    const p = validityProblems({ ...COHERENT, validity: { ...COHERENT.validity, approach: 240 } })
    assert.match(p[0], /inside the validity range/)
})

test('readiness reports coherence problems separately from missing fields', () => {
    const r = setupReadiness({
        asset: 'NVDA', direction: 'long', type: 'swing', quantity: 100,
        conditions:  [{ id: 'c1', text: 'CHoCH up on the 15m' }],
        entry_zones: [{ lower: 237.8, upper: 238.6 }],
        stop_zones:  [{ lower: 234.8, upper: 235.9 }],
        validity:    { lower: 230, upper: 244 },
    }, true)
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
    assert.equal(s.trade_mode, 'classical', 'unknown lens → the default lens')
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

test('rr is null when a leg is missing or the entry sits inside its own stop', () => {
    assert.equal(computeRR(normalizeSetup({ ...DRAFT, tp_zones: [] })), null)
    assert.equal(computeRR(normalizeSetup({ ...DRAFT, stop_zones: [{ lower: 239, upper: 240 }] })), null)
})
