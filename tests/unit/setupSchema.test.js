import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    normalizeLeg, normalizeLegs, scenarioQuantity,
    normalizeConditions, normalizeSymbols, normalizeValidity, validityProblems, rangeProblems,
    normalizeSetup, setupReadiness, computeRR, TF_RUNGS,
    normalizePaceRungs, paceRungs, resolveRung, defaultReadMode, normalizeWatch,
    normalizePremise, PREMISE_STATES,
    normalizeScenarios, pickScenario, projectScenario, scenarioView, declaredConditions, scenarioLabel,
    stopEdge, targetEdges, targetLevels, clampGuards, addEntryLeg, legQuantity, pendingLegs, watchedLegs, hasWatchedLegs, allowedVerdicts, CONDITION_MODES, TRADE_MODES,
    normalizeAlternatives, ON_AWAY, normalizeChallenges, CHALLENGE_VERDICTS,
} from '../../services/setup.schema.js'
import { ENTRY_ARCHETYPES, STOP_ANCHORS, TARGET_ANCHORS } from '../../services/setup.taxonomy.js'
import { MODES } from '../../services/analysisModes.js'

// The `setup` entity contract (docs/desks/mentor-talos.md). Mentor authors loosely, Talos monitors
// strictly — this module is the seam, so these tests pin the coercions the monitor depends on.

// ─── Pace ──────────────────────────────────────────────────────────────
//
// `pace_rungs` replaced the derived `ladder` on 2026-09-23 (docs/design/talos-two-tier.md). READING
// is unfenced; what a setup constrains is the rung it is READ ON, because the rung is the wake clock.

test('an authored pace set is normalised to canonical rungs, coarse→fine, deduped', () => {
    assert.deepEqual(normalizePaceRungs(['15min', '4h', '15min', 'daily']), ['day', '4hr', '15min'])
    const rungs = normalizePaceRungs(['5min', '1hr', '30min'])
    const idx = rungs.map(tf => TF_RUNGS.indexOf(tf))
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'canonical order, never the model\'s')
})

test('an unusable rung falls out rather than rejecting the field', () => {
    assert.deepEqual(normalizePaceRungs(['1hr', '1min', 'fortnight', null, 42]), ['1hr'])
    for (const bad of [null, undefined, 'day', 42, {}]) {
        assert.deepEqual(normalizePaceRungs(bad), [], String(bad))
    }
})

test('THERE IS NO CAP on how many rungs a user may name', () => {
    // A cap would be the system overruling the user, which is the one thing this field is for.
    const many = ['month', 'week', 'day', '4hr', '2hr', '1hr', '30min', '15min', '5min']
    assert.deepEqual(normalizePaceRungs(many), many)
})

test('paceRungs falls back premise-then-ladder, and is never empty', () => {
    assert.deepEqual(paceRungs({ pace_rungs: ['15min'] }), ['15min'])
    assert.deepEqual(paceRungs({ timeframe: '4hr' }), ['4hr'], 'no pace set → the premise')
    assert.deepEqual(paceRungs({ type: 'swing', market_cap: 'large' }), ['day', '4hr', '2hr', '1hr'])
    assert.ok(paceRungs({}).length, 'a bare document still has somewhere to be read')
})

test('a named rung is ABSOLUTE — Talos may not roam outside it', () => {
    const told = { timeframe: 'day', pace_rungs: ['15min'] }
    assert.equal(resolveRung('15min', told), '15min')
    assert.equal(resolveRung('4hr', told), null, 'not even to the premise it was drawn on')
    assert.equal(resolveRung('day', told), null)
})

test('pace and premise are independent — a daily plan may be read on the 15min', () => {
    // The case the derived ±2 ladder could not express at all: the two are 5 rungs apart.
    const s = normalizeSetup({ ...DRAFT, timeframe: 'day', pace_rungs: ['15min'] })
    assert.equal(s.timeframe, 'day')
    assert.deepEqual(s.pace_rungs, ['15min'])
})

test('resolveRung rejects what it cannot place, so the caller owns the fallback', () => {
    assert.equal(resolveRung('1min', { pace_rungs: ['5min'] }), null, 'never fetchable')
    assert.equal(resolveRung('fortnight', {}), null)
    assert.equal(resolveRung(null, {}), null)
    assert.equal(resolveRung('4h', { pace_rungs: ['4hr'] }), '4hr', 'loose spellings still resolve')
})

// ─── read_mode ────────────────────────────────────────────────────────

const conds = (...specs) => specs.map((sp, i) => ({ id: `c${i + 1}`, text: `condition ${i + 1}`, ...sp }))

test('the opening read_mode is read off the conditions, never asked for', () => {
    const mk = (cs) => defaultReadMode({ conditions: cs, scenarios: [] })
    assert.equal(mk(conds({ mode: 'measured' }, { mode: 'measured' })), 'cheap_only',
        'numbers are the whole question')
    assert.equal(mk(conds({ mode: 'judgment' }, { mode: 'judgment' })), 'expensive_only',
        'nothing a cheap read could settle')
    assert.equal(mk(conds({ mode: 'judgment', persistence: 'latching' }, { mode: 'measured' })),
        'expensive_then_cheap', 'a structural precondition, then arithmetic')
    assert.equal(mk(conds({ mode: 'judgment', persistence: 'live' }, { mode: 'measured' })),
        'cheap_then_expensive', 'a judgment that can flip needs eyes every time')
    assert.equal(mk([]), 'cheap_then_expensive', 'nothing declared → the default')
})

test('a model-authored read_mode is honoured when it is one of ours', () => {
    assert.equal(normalizeSetup({ ...DRAFT, read_mode: 'both' }).read_mode, 'both')
    assert.equal(normalizeSetup({ ...DRAFT, read_mode: 'whenever' }).read_mode,
        normalizeSetup(DRAFT).read_mode, 'junk falls to the derived default')
})

test('read_mode is NOT `mode` — that key is the workspace', () => {
    // live | paper | manual is stamped at Generate. Two meanings on one key is the trap the
    // condition-`mode` rename exists to avoid.
    const s = normalizeSetup({ ...DRAFT, read_mode: 'cheap_only' })
    assert.equal(s.read_mode, 'cheap_only')
    assert.equal(s.mode, undefined, 'normalizeSetup never writes the workspace')
})

// ─── watch ───────────────────────────────────────────────────────────

test('watch normalises to a fetchable rung plus deduped indicators', () => {
    assert.deepEqual(normalizeWatch({ rung: '15m', indicators: ['VWAP', 'vwap', ' ema(20) '] }),
        { rung: '15min', indicators: ['vwap', 'ema(20)'] })
    assert.deepEqual(normalizeWatch({ rung: '4hr', indicators: [] }), { rung: '4hr', indicators: [] })
})

test('watch is NULL when there is nothing a numbers-only pass could check', () => {
    // Not a gap — it puts the setup to sleep until the next expensive read or a guard.
    for (const bad of [null, undefined, {}, [], 'vwap', { rung: '1min' }, { rung: 'fortnight' }]) {
        assert.equal(normalizeWatch(bad), null, JSON.stringify(bad))
    }
})

// ─── Legs ─────────────────────────────────────────────────────────────────────
//
// A LEG IS A PRICE (2026-09-24). The three tests that used to live here — edges sorted, one edge
// mirroring the other, a band surviving normalisation — described the `{lower, upper}` shape and
// went with it. What replaces them is narrower on purpose: there is one number, it is either there
// or it is not, and the only failure left is an unpriced leg.

test('a leg is its price — the authored spelling, stored as authored', () => {
    const z = normalizeLeg({ price: 235.5, quantity: 10 }, 0, 'sz')
    assert.equal(z.price, 235.5)
    assert.equal(z.quantity, 10)
    assert.equal(z.lower, undefined, 'no edges survive anywhere in the document')
    assert.equal(z.upper, undefined)
})

test('a leg with no usable price is DROPPED, never stored half-formed', () => {
    // Dropping is the safe direction here and the readiness gate is what reports it: a leg stored
    // with a null price is a stop the UI draws and the broker never rests.
    assert.equal(normalizeLeg({ note: 'somewhere around the shelf' }, 0, 'ez'), null)
    assert.equal(normalizeLeg(null, 0, 'ez'), null)
    assert.equal(normalizeLeg({ price: 'abc' }, 0, 'ez'), null)
    assert.equal(normalizeLegs([{ price: 'abc' }, { price: 1 }], 'ez').length, 1)
})

test('THE BAND SHAPE IS NOT ACCEPTED — a pre-wipe document has no legs, not half a leg', () => {
    // Every setup was deleted when the shape changed (2026-09-24), so nothing in Mongo carries
    // edges. Reading them here "just in case" is how a deleted shape comes back: the normaliser is
    // the one door, and a document that comes through it either speaks prices or is empty.
    assert.equal(normalizeLeg({ lower: 238, upper: 238 }, 0, 'ez'), null)
    assert.equal(normalizeLeg({ lower: 237.8, upper: 238.6 }, 0, 'ez'), null)
})

test('leg ids are auto-assigned by position when the model omits them', () => {
    const legs = normalizeLegs([{ price: 1 }, { price: 3, id: 'custom' }], 'ez')
    assert.deepEqual(legs.map(z => z.id), ['ez1', 'custom'])
})

test('a non-positive or absent quantity becomes null, never 0', () => {
    // 0 would read as "size it at zero"; null reads as "not sized yet" and blocks readiness.
    for (const q of [0, -5, 'abc', undefined]) {
        assert.equal(normalizeLeg({ price: 1, quantity: q }, 0, 'ez').quantity, null, String(q))
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
    stop_legs: [{ price: 234.8 }],
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
        stop_legs: [{ price: 244 }],
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
              entry_legs: [{ price: 238.6, quantity: 100 }],
              stop_legs:  [{ price: 234.8 }],
              validity:    { lower: 235.5, upper: 244 } },
            { id: 's2', name: 'break and go',
              entry_legs: [{ price: 244.9, quantity: 60 }],
              stop_legs:  [{ price: 241.8 }],
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
        entry_legs: [{ price: 238.6, quantity: 100 }],
        stop_legs:  [{ price: 234.8 }],
        target_legs:    [{ price: 246 }],
        // `on_away` authored so this test stays about COHERENCE. A range that can report a runaway
        // and says nothing about one is its own missing field, covered below.
        validity:    { lower: 230, upper: 244, on_away: 'revise' },
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
    entry_legs: [{ price: 238.6, quantity: 100 }],
    stop_legs:  [{ price: 234.8, quantity: 100 }],
    target_legs:    [{ price: 246.0, quantity: 100 }],
    valid_until: '2026-08-08T20:00:00Z',
}

test('a well-formed draft normalises and derives its server-owned fields', () => {
    const s = normalizeSetup(DRAFT)
    assert.equal(s.asset, 'NVDA')
    assert.equal(s.quantity, 100)
    assert.equal(s.ladder, undefined, 'the derived ladder is gone — pace is authored now')
    assert.equal(s.cadence, undefined, 'the rung is the pace — no cadence on the document')
})

test('server-derived fields overwrite anything the model tried to author', () => {
    const s = normalizeSetup({ ...DRAFT, quantity: 9999, ladder: ['month'] })
    assert.equal(s.quantity, 100, 'quantity comes from the entry zones')
    assert.equal(s.ladder, undefined, 'a model-authored ladder is not a field any more')
})

test('pace_rungs IS taken from the model — which chart a plan is read on is the plan\'s call', () => {
    const s = normalizeSetup({ ...DRAFT, pace_rungs: ['15min', '1min'] })
    assert.deepEqual(s.pace_rungs, ['15min'], 'authored, with the unfetchable rung dropped')
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
    assert.deepEqual(s.entry_legs, [])
    assert.equal(s.quantity, null)
    assert.equal(normalizeSetup(null), null)
    assert.equal(normalizeSetup([]), null)
})

// ─── Readiness ────────────────────────────────────────────────────────────────

test('a complete setup with a marked account is ready', () => {
    // `warnings` never bear on `ready` — DRAFT records no rejected ways in, which is a thing to say
    // and not a thing to block on (docs/design/mentor-challenge.md §1, coverage strength 2).
    assert.deepEqual(setupReadiness(normalizeSetup(DRAFT), true),
        { ready: true, missing: [], problems: [], warnings: ['no rejected ways in recorded'] })
})

test('readiness names what is missing, so the UI never shows a dead button', () => {
    const { ready, missing } = setupReadiness(normalizeSetup(DRAFT), false)
    assert.equal(ready, false)
    assert.deepEqual(missing, ['trading account'])
})

test('a setup with no stop zone is never ready', () => {
    const { ready, missing } = setupReadiness(normalizeSetup({ ...DRAFT, stop_legs: [] }), true)
    assert.equal(ready, false)
    assert.ok(missing.includes('stop price'))
})

test('an unsized setup is never ready', () => {
    const s = normalizeSetup({ ...DRAFT, entry_legs: [{ price: 238.6 }] })
    assert.ok(setupReadiness(s, true).missing.includes('quantity'))
})

// ─── rr ───────────────────────────────────────────────────────────────────────

test('planned rr is measured from the WORST entry edge, never the midpoint', () => {
    // long: worst fill 238.6, stop 234.8 → risk 3.8; target 246.0 → reward 7.4 ⇒ 1.95
    assert.equal(computeRR(normalizeSetup(DRAFT)), 1.95)
})

test('THE PESSIMISM THAT SURVIVED THE BANDS — the furthest stop, the nearest target', () => {
    // The worst-entry-edge term is gone with the edges: an entry is the one price the user named,
    // so there is no favourable side of it left to decline. The other two halves of "never flatter"
    // are not about width and stay exactly as they were.
    const s = normalizeSetup({ ...DRAFT,
        stop_legs:   [{ price: 236.5 }, { price: 234.8 }],
        target_legs: [{ price: 246.0, quantity: 50 }, { price: 260.0, quantity: 50 }] })
    assert.equal(stopEdge(s), 234.8, 'risk runs to the FURTHEST stop')
    assert.equal(targetEdges(s)[0], 246.0, 'reward to the NEAREST target')
    // Quoting the far target and the near stop is the flattering version; it must be worse.
    const flattering = (260.0 - 238.6) / (238.6 - 236.5)
    assert.ok(computeRR(s) < flattering, 'the plan must not flatter itself')
})

test('rr mirrors for a short', () => {
    const short = normalizeSetup({
        ...DRAFT, direction: 'short',
        entry_legs: [{ price: 238.6, quantity: 100 }],
        stop_legs:  [{ price: 241.0, quantity: 100 }],
        target_legs:    [{ price: 230.0, quantity: 100 }],
    })
    // entry 238.6, stop 241.0 → risk 2.4; target 230.0 → reward 8.6 ⇒ 3.58
    assert.equal(computeRR(short), 3.58)
})

test('live rr overrides the planned entry with the actual fill', () => {
    const s = normalizeSetup(DRAFT)
    // Filling below your own entry on a long is a better trade than the plan advertised.
    assert.ok(computeRR(s, 237.8) > computeRR(s))
})

test('rr picks the NEAREST target and the WIDEST stop, whatever order they were emitted in', () => {
    // The model reasons about targets in narrative order, not price order. Indexing [0] would
    // hand this setup the rr of its far target and overstate the trade.
    const jumbled = normalizeSetup({
        ...DRAFT,
        target_legs:   [{ price: 260, quantity: 50 }, { price: 246, quantity: 50 }],
        stop_legs: [{ price: 236.5 }, { price: 234.8 }],
    })
    // nearest tp 246, widest stop 234.8, worst entry 238.6 → identical to the single-leg case.
    assert.equal(computeRR(jumbled), 1.95)
})

// ─── stopEdge / targetEdges — the levels the in-position gate measures against ──
// Both are selected BY PRICE, never by array position. The model emits zones in the order it
// reasoned about them, so `[0]` is a coin flip: it would hand the gate the near stop instead of the
// working one, and fire a partial ladder in whatever order the sentences came out.

test('stopEdge takes the FURTHEST stop — the most risk the plan actually admits', () => {
    const long = normalizeSetup({
        ...DRAFT,
        stop_legs: [{ price: 236.5 }, { price: 234.8 }],
    })
    assert.equal(stopEdge(long), 234.8, 'the furthest stop, not stop_legs[0]')

    // Mirrored on a short: widest means the HIGHEST edge, because that is where the risk ends.
    const short = normalizeSetup({ ...DRAFT, direction: 'short',
        entry_legs: [{ price: 238.6, quantity: 100 }],
        stop_legs:  [{ price: 240.5 }, { price: 242.2 }],
        target_legs: [{ price: 230, quantity: 100 }],
    })
    assert.equal(stopEdge(short), 242.2)
})

test('stopEdge is null when nothing is authored, rather than 0', () => {
    // A 0 here would read as "the stop is at zero", i.e. infinite risk on a long — and the gate
    // would then never see price press it.
    assert.equal(stopEdge(normalizeSetup({ ...DRAFT, stop_legs: [] })), null)
    assert.equal(stopEdge(null), null)
})

test('targetEdges come back NEAREST-FIRST — the order price reaches them', () => {
    // That is also the order a partial ladder must fire in. Array order would take the far leg first.
    const long = normalizeSetup({
        ...DRAFT,
        target_legs: [{ price: 260, quantity: 50 }, { price: 246, quantity: 50 }],
    })
    assert.deepEqual(targetEdges(long), [246, 260], 'nearest first, despite being emitted second')

    const short = normalizeSetup({ ...DRAFT, direction: 'short',
        entry_legs: [{ price: 238.6, quantity: 100 }],
        stop_legs:  [{ price: 241 }],
        target_legs: [{ price: 221, quantity: 50 }, { price: 233, quantity: 50 }],
    })
    assert.deepEqual(targetEdges(short), [233, 221], 'a short reaches the HIGHEST target first')
})

test('targetLevels reads a target leg as the price the limit rests at', () => {
    // It IS the target. This used to have a third case — a legacy band resting at its far side,
    // which is also where `targetLevels` and `targetEdges` were allowed to disagree (rr read the
    // near edge so it could never flatter). One price per leg, so they agree by construction.
    const long = normalizeSetup({ ...DRAFT, direction: 'long',
        target_legs: [{ price: 260 }, { price: 245 }] })
    assert.deepEqual(long.scenarios[0].target_legs.map(z => z.price), [260, 245], 'stored as authored')
    assert.deepEqual(targetLevels(long).map(t => t.target), [245, 260], 'nearest-first')
    assert.deepEqual(targetEdges(long), targetLevels(long).map(t => t.target),
        'what rr measures and what rests are now one number')

    const short = normalizeSetup({ ...DRAFT, direction: 'short', target_legs: [{ price: 220 }, { price: 232 }] })
    assert.deepEqual(targetLevels(short).map(t => t.target), [232, 220], 'a short reaches the HIGHEST target first')
})

test('a target carries its own conditions, in the same shape an entry condition has', () => {
    // The whole reason there is no exit evaluator: an exit condition is a SENTENCE the model judges,
    // not a tree software resolves. Same normaliser, same three axes, same document-wide id space.
    const s = normalizeSetup({ ...DRAFT, direction: 'long',
        target_legs: [{ price: 260, conditions: [{ text: 'only if volume confirms the push', weight: 'primary' }] }] })
    const [tp] = s.scenarios[0].target_legs
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
        target_legs:   [{ price: 260, conditions: [{ id: 'x1', text: 'volume confirms' }] }],
        stop_legs: [{ price: 234, conditions: [{ id: 'x1', text: 'closes below the 4hr VWAP' }] }],
    })
    const ids = [
        ...s.conditions.map(c => c.id),
        ...s.scenarios[0].target_legs.flatMap(z => z.conditions.map(c => c.id)),
        ...s.scenarios[0].stop_legs.flatMap(z => z.conditions.map(c => c.id)),
    ]
    assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids.join(', ')}`)
})

test('a zero-width tp zone is a level with nothing to discuss', () => {
    const s = normalizeSetup({ ...DRAFT, direction: 'long', target_legs: [{ price: 246 }] })
    assert.deepEqual(targetLevels(s), [{ target: 246, quantity: null, conditions: [] }])
})

test('a setup cannot be generated without a target PRICE', () => {
    // The far edge of a tp band is the limit that rests at the broker. A premise without one is a
    // position that can only be closed by its stop, by hand, or by Talos noticing — half a plan.
    const base = {
        asset: 'NVDA', direction: 'long', type: 'swing',
        conditions:  [{ id: 'c1', text: 'CHoCH up on the 15m' }],
        entry_legs: [{ price: 238.6, quantity: 100 }],
        stop_legs:  [{ price: 234.8 }],
    }
    assert.match(setupReadiness(normalizeSetup(base), true).missing.join(' '), /target price/)

    // A band of nulls is a zone to the array and no price to the broker.
    const blank = setupReadiness(normalizeSetup({ ...base, target_legs: [{ lower: null, upper: null }] }), true)
    assert.match(blank.missing.join(' '), /target price/)

    const ok = setupReadiness(normalizeSetup({ ...base, target_legs: [{ price: 246 }] }), true)
    assert.deepEqual(ok.missing, [])
    assert.equal(ok.ready, true)
})

test('a missing target names WHICH premise is short of one', () => {
    const two = normalizeSetup({
        asset: 'NVDA', direction: 'long', type: 'swing',
        conditions: [{ id: 'c1', text: 'SMH leading' }],
        scenarios: [
            { id: 's1', name: 'false break', entry_legs: [{ price: 238.6, quantity: 100 }],
              stop_legs: [{ price: 234.8 }], target_legs: [{ price: 246 }] },
            { id: 's2', name: 'break and go', entry_legs: [{ price: 244.9, quantity: 60 }],
              stop_legs: [{ price: 241.8 }] },
        ],
    })
    assert.deepEqual(setupReadiness(two, true).missing, ['target price on break and go'])
})

test('targetEdges is empty, never [null], when none is authored', () => {
    // The fill path maps this into position_state.targets — a null in there would become a target
    // the gate compares price against forever.
    assert.deepEqual(targetEdges(normalizeSetup({ ...DRAFT, target_legs: [] })), [])
    assert.deepEqual(targetEdges(null), [])
})

test('rr is null when a leg is missing or the entry sits inside its own stop', () => {
    assert.equal(computeRR(normalizeSetup({ ...DRAFT, target_legs: [] })), null)
    assert.equal(computeRR(normalizeSetup({ ...DRAFT, stop_legs: [{ price: 239 }] })), null)
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
          entry_legs: [{ price: 238.6, quantity: 100 }],
          stop_legs:  [{ price: 234.8 }],
          target_legs:    [{ price: 246.0 }] },
        { id: 's2', name: 'break and go',
          conditions:  [{ text: '1hr close above 244 on volume', weight: 'primary', mode: 'measured' }],
          entry_legs: [{ price: 244.9, quantity: 60 }],
          stop_legs:  [{ price: 241.0 }],
          target_legs:    [{ price: 252.0 }] },
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
    assert.deepEqual(s.entry_legs, s.scenarios[0].entry_legs, 'pre-arm: the primary')
    assert.deepEqual(s.stop_legs,  s.scenarios[0].stop_legs)
    assert.equal(s.rr, s.scenarios[0].rr)

    const armed = normalizeSetup({ ...RIVALS, armed_scenario_id: 's2' })
    assert.deepEqual(armed.entry_legs, armed.scenarios[1].entry_legs)
    assert.deepEqual(armed.target_legs,    armed.scenarios[1].target_legs)
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
    const s = normalizeSetup({ ...RIVALS, scenarios: [RIVALS.scenarios[0], { ...RIVALS.scenarios[1], stop_legs: [] }] })
    const { ready, missing } = setupReadiness(s, true)
    assert.equal(ready, false)
    assert.deepEqual(missing, ['stop price on break and go'])
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
        entry_legs: [{ price: 238.6, quantity: 100 }],
        stop_legs:  [{ price: 234.8 }],
        target_legs:    [{ price: 246 }],
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
        entry_legs: [{ price: 238.6, quantity: 60 }, { price: 236.8, quantity: 40 }],
    }, RIVALS.scenarios[1]] })
    assert.deepEqual(setupReadiness(s, true).missing, [])
})

test('a scale-in leg with no size of its own is refused', () => {
    // A sized leg falls back to the premise total, so an unsized second leg would place the WHOLE
    // position on the first print — exactly the failure the old blanket block existed to prevent.
    const s = normalizeSetup({ ...RIVALS, scenarios: [{
        ...RIVALS.scenarios[0],
        entry_legs: [{ price: 238.6, quantity: 60 }, { price: 236.8 }],
    }, RIVALS.scenarios[1]] })
    assert.match(setupReadiness(s, true).missing.join(' '), /size on every entry leg/)
})

test('a leg drawn PAST the stop is refused — price could never reach it', () => {
    // Found while writing scale-in fixtures: a second leg under the stop made every gate report
    // `adverse`, correctly. It reads like a plan to add twice and can only ever add once.
    const s = normalizeSetup({ ...RIVALS, scenarios: [{
        ...RIVALS.scenarios[0],
        stop_legs:  [{ price: 234.8 }],
        entry_legs: [{ price: 238.6, quantity: 60 }, { price: 232, quantity: 40 }],
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
    assert.deepEqual(s.scenarios[0].entry_legs, s.entry_legs, 'the projection matches the wrap')
    assert.equal(s.scenarios[0].validity.on_break, 'close', 'the root range moves down with it')
    assert.equal(s.validity.on_break, 'close', 'and is projected back up for the FE')
})

test('re-normalising an already-scenario document is idempotent', () => {
    const once  = normalizeSetup(RIVALS)
    const twice = normalizeSetup(once)
    assert.deepEqual(twice.scenarios, once.scenarios)
    assert.deepEqual(twice.entry_legs, once.entry_legs)
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

test('an unsized leg does not become a leg at 0 on the second pass', () => {
    // Number(null) is 0, and this module re-normalises its own output on every streamed turn.
    const once  = normalizeLeg({ price: 238.6, quantity: null }, 0, 'ez')
    const twice = normalizeLeg(once, 0, 'ez')
    assert.equal(twice.price, 238.6, 'the level survives the round trip')
    assert.equal(twice.quantity, null, 'and an absent size stays absent')
})

// ─── plan levels: chosen by PRICE, never by array position ────────────────────
// The model emits legs in whatever order it reasoned about them. computeRR already depended on
// this rule; the position gate now does too, so it lives in one place rather than being re-derived
// by every caller that needs "which stop am I actually working against".

test('the working stop is the FURTHEST, whatever order the legs arrived in', () => {
    // Furthest = most risk the plan admits. Taking the nearest would understate risk and overstate R.
    const long = { direction: 'long', stop_legs: [{ price: 96 }, { price: 94 }] }
    assert.equal(stopEdge(long), 94)

    const short = { direction: 'short', stop_legs: [{ price: 103 }, { price: 105 }] }
    assert.equal(stopEdge(short), 105, 'a short works against the HIGHEST stop')
})

test('DIRECTION PICKS A LEG, NEVER AN EDGE — the level itself is the same number either way', () => {
    // This replaces "a long and a short read opposite edges of the same band". A leg has one price,
    // so direction no longer changes what a given leg IS — only which of several is furthest.
    const legs = [{ price: 94 }]
    assert.equal(stopEdge({ direction: 'long',  stop_legs: legs }), 94)
    assert.equal(stopEdge({ direction: 'short', stop_legs: legs }), 94)
})

test('targets come back nearest-first, which is the order partials fire in', () => {
    const long = { direction: 'long', target_legs: [{ price: 120 }, { price: 105 }] }
    assert.deepEqual(targetEdges(long), [105, 120], 'authored far-then-near, returned near-then-far')

    const short = { direction: 'short', target_legs: [{ price: 81 }, { price: 96 }] }
    assert.deepEqual(targetEdges(short), [96, 81], 'a short falls INTO its targets')
})

test('no legs authored → null stop and an empty ladder, never a thrown or a NaN', () => {
    assert.equal(stopEdge({ direction: 'long' }), null)
    assert.equal(stopEdge(null), null)
    assert.deepEqual(targetEdges({ direction: 'long' }), [])
    assert.deepEqual(targetEdges(null), [])
})

test('an unpriced leg is skipped rather than poisoning the selection', () => {
    // One malformed leg must not make Math.min return NaN and take the whole gate down with it.
    const s = { direction: 'long', stop_legs: [{ note: 'around the shelf' }, { price: 94 }] }
    assert.equal(stopEdge(s), 94)
})

test('computeRR still quotes the furthest stop against the nearest target', () => {
    // The extraction must not change the number: rr is what the plan advertises to the user.
    const setup = {
        direction: 'long',
        entry_legs: [{ price: 100 }],
        stop_legs:   [{ price: 96 }, { price: 94 }],    // furthest = 94 → risk 6
        target_legs: [{ price: 120 }, { price: 106 }],  // nearest  = 106 → reward 6
    }
    assert.equal(computeRR(setup), 1)
})

// ─── Entry legs — the arithmetic scaling in rests on ──────────────────────────
// A scaled position is several fills at different prices, so `entry` becomes an aggregate. This
// lands BEFORE per-leg execution because everything downstream measures from `fill_price`:
// rMultiple feeds computeMetrics' R / mae / mfe, which every in-position read is handed, so an
// average that is wrong misreports R on every read of every scaled position.

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
        { leg_id: 'ez1', price: 50, quantity: 10 }), { leg_id: 'ez2', price: 60, quantity: 10 })
    assert.deepEqual(e.legs.map(l => l.leg_id), ['ez1', 'ez2'])
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
    const sc = { entry_legs: [{ id: 'ez1', quantity: 60 }, { id: 'ez2', quantity: 40 }] }
    assert.equal(legQuantity(sc, 'ez1'), 60)
    assert.equal(legQuantity(sc, 'ez2'), 40)
})

test('with ONE entry zone the leg and the premise agree — which is why this is inert today', () => {
    // scenarioQuantity of a single zone IS that zone's quantity, so nothing changes until a
    // premise actually has two legs.
    const sc = { entry_legs: [{ id: 'ez1', quantity: 100 }] }
    assert.equal(legQuantity(sc, 'ez1'), scenarioQuantity(sc.entry_legs))
})

test('an unsized or unknown zone yields null, so the caller falls back to the premise total', () => {
    // Never 0 — a zero would place nothing and read as a successful entry.
    assert.equal(legQuantity({ entry_legs: [{ id: 'ez1' }] }, 'ez1'), null)
    assert.equal(legQuantity({ entry_legs: [{ id: 'ez1', quantity: 0 }] }, 'ez1'), null)
    assert.equal(legQuantity({ entry_legs: [{ id: 'ez1', quantity: 10 }] }, 'nope'), null)
    assert.equal(legQuantity(null, 'ez1'), null)
})

test('legs never sum across a premise at execution time', () => {
    // The safety property, from the other side: two legs of 60 and 40 must place 60, not 100.
    const sc = { entry_legs: [{ id: 'ez1', quantity: 60 }, { id: 'ez2', quantity: 40 }] }
    assert.equal(scenarioQuantity(sc.entry_legs), 100, 'the premise is 100 in total')
    assert.notEqual(legQuantity(sc, 'ez1'), 100, 'but the first print is not')
})

// ─── Pending legs, and when adding is allowed ─────────────────────────────────

const TWO_LEG = { entry_legs: [{ id: 'ez1', price: 101, quantity: 60 },
                                { id: 'ez2', price: 96,  quantity: 40 }] }

test('a filled leg drops out, and the rest stay pending', () => {
    const pend = pendingLegs(TWO_LEG, { legs: [{ leg_id: 'ez1' }] })
    assert.deepEqual(pend.map(z => z.id), ['ez2'])
})

test('legs are matched by ID, not by count — they fill in whatever order price reaches them', () => {
    // A dip leg and a reclaim leg fill in the order the market offers, not the order authored.
    const pend = pendingLegs(TWO_LEG, { legs: [{ leg_id: 'ez2' }] })
    assert.deepEqual(pend.map(z => z.id), ['ez1'], 'the SECOND authored leg filled first')
})

test('a single-leg premise has nothing pending once it fills — the whole path stays inert today', () => {
    const one = { entry_legs: [{ id: 'ez1', quantity: 100 }] }
    assert.equal(pendingLegs(one, { legs: [{ leg_id: 'ez1' }] }).length, 0)
})

test('an unfilled premise is entirely pending, and a missing scenario is not a crash', () => {
    assert.equal(pendingLegs(TWO_LEG, null).length, 2)
    assert.equal(pendingLegs(TWO_LEG, { legs: [] }).length, 2)
    assert.equal(pendingLegs(null, { legs: [] }).length, 0)
})

// ─── Watched legs: the one predicate for an in-position read ─────────────────
// docs/design/talos-per-candle.md. A plain level is an order at the broker; only a leg carrying a
// condition in words costs a model call, and the verdict menu follows from which legs those are.

const COND = [{ id: 'x1', text: 'out if it closes below the 4hr VWAP', weight: 'primary', mode: 'judgment', persistence: 'live' }]
const PLAIN_SC = {
    id: 'sc1',
    entry_legs: [{ id: 'e1', price: 100, quantity: 10, conditions: [] }],
    stop_legs:  [{ id: 's1', price: 95,  quantity: 10, conditions: [] }],
    target_legs:    [{ id: 't1', price: 110, quantity: 10, conditions: [] }],
}

test('a scenario of plain levels watches nothing — the broker holds it all', () => {
    const w = watchedLegs({ entry_mode: 'limit' }, PLAIN_SC, { legs: [{ leg_id: 'e1' }] })
    assert.deepEqual(w, { stop: null, targets: [], entries: [] })
    assert.equal(hasWatchedLegs(w), false)
    assert.deepEqual(allowedVerdicts(w), ['hold'])
})

test('a conditional stop is watched and unlocks the stop verdicts only', () => {
    const sc = { ...PLAIN_SC, stop_legs: [{ ...PLAIN_SC.stop_legs[0], conditions: COND }] }
    const w  = watchedLegs({ entry_mode: 'limit' }, sc, { legs: [{ leg_id: 'e1' }] })
    assert.equal(w.stop?.id, 's1')
    assert.equal(hasWatchedLegs(w), true)
    assert.deepEqual(allowedVerdicts(w), ['hold', 'move_stop', 'exit_now'])
})

test('a conditional target is watched and unlocks take_partial only', () => {
    const sc = { ...PLAIN_SC, target_legs: [PLAIN_SC.target_legs[0], { id: 't2', price: 120, quantity: 5, conditions: COND }] }
    const w  = watchedLegs({ entry_mode: 'limit' }, sc, { legs: [{ leg_id: 'e1' }] })
    assert.deepEqual(w.targets.map(t => t.id), ['t2'], 'the plain target is not on the list')
    assert.deepEqual(allowedVerdicts(w), ['hold', 'take_partial'])
})

test("a pending entry leg is watched while unfilled — on its own conditions, or the setup's", () => {
    const sc = { ...PLAIN_SC, entry_legs: [PLAIN_SC.entry_legs[0], { id: 'e2', price: 96, quantity: 10, conditions: [] }] }
    const conditional = { entry_mode: 'conditional', conditions: COND }
    // A conditional setup: the setup's own entry conditions apply to every leg.
    assert.deepEqual(watchedLegs(conditional, sc, { legs: [{ leg_id: 'e1' }] }).entries.map(z => z.id), ['e2'])
    assert.deepEqual(watchedLegs(conditional, sc, { legs: [{ leg_id: 'e1' }, { leg_id: 'e2' }] }).entries, [], 'filled → nothing to add')
    assert.deepEqual(allowedVerdicts(watchedLegs(conditional, sc, { legs: [{ leg_id: 'e1' }] })), ['hold', 'add_leg'])
    // A limit setup declares nothing: a plain pending leg is not a read.
    assert.deepEqual(watchedLegs({ entry_mode: 'limit' }, sc, { legs: [{ leg_id: 'e1' }] }).entries, [])
    // …unless the leg carries its own condition.
    const own = { ...sc, entry_legs: [sc.entry_legs[0], { ...sc.entry_legs[1], conditions: COND }] }
    assert.deepEqual(watchedLegs({ entry_mode: 'limit' }, own, { legs: [{ leg_id: 'e1' }] }).entries.map(z => z.id), ['e2'])
})

test('a missing scenario watches nothing and is not a crash', () => {
    assert.equal(hasWatchedLegs(watchedLegs(null, null, null)), false)
    assert.deepEqual(allowedVerdicts(null), ['hold'])
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
// docs/design/talos-per-candle.md. A guard is a price and a side; `clampGuards` is the half of
// the contract that cannot be talked out of it.

test('a guard is a price, a side and a meaning — nothing else survives', () => {
    const [g] = clampGuards([{ after_min: 30, price: 305, direction: 'above', means: 'entry', extra: 1 }], 300)
    assert.deepEqual(g, { price: 305, direction: 'above', means: 'entry' })
})

test('a missing direction is inferred from where price actually is', () => {
    // A level with no side is not a crossing, it is a number.
    assert.equal(clampGuards([{ price: 311.5 }], 305)[0].direction, 'above')
    assert.equal(clampGuards([{ price: 300 }],   305)[0].direction, 'below')
    assert.equal(clampGuards([{ price: 300 }],   null)[0].direction, 'any', 'unknown price → a touch, the safe error')
})

test('an ALREADY-TRUE price guard is dropped — it would be a paid infinite loop', () => {
    // "below 305" armed while price is already 300 is satisfied the instant it is written: it wakes
    // the model, which re-arms it, which wakes the model.
    assert.deepEqual(clampGuards([{ price: 305, direction: 'below' }], 300), [])
    assert.deepEqual(clampGuards([{ price: 305, direction: 'above' }], 310), [])
    assert.equal(clampGuards([{ price: 305, direction: 'any' }], 300).length, 1, 'a touch is exempt: it needs price to ARRIVE')
})

test('a guard without a finite price cannot fire, so it is dropped — including the old time-only guards', () => {
    assert.deepEqual(clampGuards([{ means: 'entry' }, { price: 'soon' }, { after_min: 240 }, { price: -3 }], 300), [])
})

test('an empty or junk set is an empty set', () => {
    for (const raw of [[], null, undefined, 'nonsense', [null, 7, 'x']]) {
        assert.deepEqual(clampGuards(raw, 300), [], JSON.stringify(raw))
    }
})

test('price levels are capped, so one read cannot arm a hedge instead of a watch', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ price: 400 + i, direction: 'above' }))
    assert.equal(clampGuards(many, 300).length, 6)
})

test('only a known MEANING survives, so a wake cannot arrive mislabelled', () => {
    assert.equal(clampGuards([{ price: 311, direction: 'above', means: 'entry' }], 305)[0].means, 'entry')
    assert.equal(clampGuards([{ price: 311, direction: 'above', means: 'vibes' }], 305)[0].means, null)
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

// ─── premise — is the MAP still true (2026-09-23) ──────────────────────────────
//
// Asked separately from the verdict, because they are different questions. Until this existed the
// only way to say "the thesis is rotting" was a verdict that also ACTED on it, so a read that
// wanted to keep waiting while flagging decay had no way to say so.

test('the three premise states, and absence means intact', () => {
    assert.deepEqual(PREMISE_STATES, ['intact', 'damaged', 'stale'])
    for (const ok of PREMISE_STATES) assert.equal(normalizePremise(ok), ok)
    // Absence is today's behaviour — nothing flagged. A read that did not raise a concern has not
    // raised one, and defaulting to `damaged` would force an expensive read on every omission.
    for (const bad of [null, undefined, '', 'broken', 'INTACT', 42, {}]) {
        assert.equal(normalizePremise(bad), 'intact', String(bad))
    }
})

// ─── The authoring taxonomy on the document ───────────────────────────────────
//
// Phase 1 of docs/design/mentor-challenge.md: the archetype, the leg anchors, the rejects pool and
// the away-edge answer. All four are AUTHORING record — none of them changes what executes, and most
// of what follows is about that boundary holding.

test('a scenario files its way in from the closed set, and junk files as nothing', () => {
    const of = (archetype) => normalizeScenarios([{ id: 's1', archetype, entry_legs: [{ price: 238.6, quantity: 100 }] }])[0].archetype
    for (const id of ENTRY_ARCHETYPES) assert.equal(of(id), id)
    assert.equal(of('  Sweep_Reclaim '), 'sweep_reclaim', 'trim and case are spelling, not meaning')
    for (const bad of [null, undefined, '', 'scalp', 42, {}]) assert.equal(of(bad), null, String(bad))
})

test('a stop and a target answer to DIFFERENT anchor vocabularies', () => {
    const sc = normalizeScenarios([{
        id: 's1',
        entry_legs:  [{ price: 238.6, quantity: 100, anchor: 'structure' }],
        stop_legs:   [{ price: 234.8, anchor: 'structure' }],
        target_legs: [{ price: 246.0, anchor: 'measured_move' }],
    }])[0]
    assert.equal(sc.stop_legs[0].anchor, 'structure')
    assert.equal(sc.target_legs[0].anchor, 'measured_move')
    // An ENTRY leg carries none: what an entry is anchored to is the scenario's archetype, and a
    // second vocabulary answering the same question is how two fields start disagreeing.
    assert.equal(sc.entry_legs[0].anchor, null)
})

test('an anchor from the wrong vocabulary is dropped, not accepted', () => {
    // `measured_move` is a TARGET anchor. On a stop it is meaningless, and accepting it would put a
    // citation in front of the user that cannot be true.
    const sc = normalizeScenarios([{
        id: 's1',
        stop_legs:   [{ price: 234.8, anchor: 'measured_move' }],
        target_legs: [{ price: 246.0, anchor: 'volatility' }],
    }])[0]
    assert.ok(!STOP_ANCHORS.includes('measured_move') && !TARGET_ANCHORS.includes('volatility'), 'the premise of this test')
    assert.equal(sc.stop_legs[0].anchor, null)
    assert.equal(sc.target_legs[0].anchor, null)
})

test('a reject needs an archetype AND a reason — an archetype alone records nothing', () => {
    const out = normalizeAlternatives([
        { archetype: 'sweep_reclaim', price: 232.4, why_not: 'the pool sits under the shelf, so the entry is below my stop' },
        { archetype: 'gap_fill' },                                 // no reason → hollow, dropped
        { archetype: 'gap_fill', why_not: '   ' },                  // whitespace is no reason either
        { archetype: 'scalp', why_not: 'not in the vocabulary' },
        { why_not: 'orphan' },
        null, 'pullback', 42,
    ])
    assert.equal(out.length, 1)
    assert.deepEqual(out[0], { archetype: 'sweep_reclaim', price: 232.4, why_not: 'the pool sits under the shelf, so the entry is below my stop' })
})

test('the rejects pool is capped and its clauses are bounded', () => {
    const many = Array.from({ length: 9 }, () => ({ archetype: 'breakout', why_not: 'x'.repeat(400) }))
    const out  = normalizeAlternatives(many)
    assert.equal(out.length, 5, 'five is a glance; a sixth is noise')
    assert.equal(out[0].why_not.length, 200, 'a clause, not a paragraph riding every re-emit')
    assert.deepEqual(normalizeAlternatives(null), [])
    assert.deepEqual(normalizeAlternatives('pullback'), [])
})

test('a price is optional on a reject — some ways in were never at a level', () => {
    const out = normalizeAlternatives([{ archetype: 'momentum_continuation', why_not: 'nothing to lean on above' }])
    assert.equal(out[0].price, null)
})

test('the away edge has NO default, where the adverse edge does', () => {
    // The asymmetry is the feature: the monitor is already safe without an answer (a runaway is
    // announced once and never closes anything), so a default would only let the question go unasked.
    const bare = normalizeValidity({ lower: 234, upper: 244 })
    assert.equal(bare.on_break, 'revise', 'the adverse edge still defaults')
    assert.equal(bare.on_away, null)
    for (const v of ON_AWAY) assert.equal(normalizeValidity({ lower: 234, on_away: v }).on_away, v)
    for (const bad of ['close', 'notify_only', 'continuation', 'mandate', '', 42]) {
        assert.equal(normalizeValidity({ lower: 234, on_away: bad }).on_away, null, String(bad))
    }
})

test('a range that can report a runaway must say what to do about one', () => {
    const base = {
        asset: 'NVDA', direction: 'long', type: 'swing',
        conditions: [{ id: 'c1', text: 'CHoCH up on the 15m' }],
        entry_legs: [{ price: 238.6, quantity: 100 }],
        stop_legs:  [{ price: 234.8 }],
        target_legs: [{ price: 246 }],
    }
    const unanswered = setupReadiness(normalizeSetup({ ...base, validity: { lower: 234, upper: 244, approach: 246.5 } }), true)
    assert.equal(unanswered.ready, false)
    // Two plain words: this string becomes `missing_runaway_answer` in the Generate refusal.
    assert.deepEqual(unanswered.missing, ['runaway answer'])

    const answered = setupReadiness(normalizeSetup({ ...base, validity: { lower: 234, upper: 244, approach: 246.5, on_away: 'pass' } }), true)
    assert.deepEqual(answered.missing, [], 'letting it go IS an answer')

    // No range at all → no away edge → nothing to answer for. The validity range stays optional.
    assert.deepEqual(setupReadiness(normalizeSetup(base), true).missing, [])
})

test('a missing runaway answer names WHICH premise is silent', () => {
    const two = normalizeSetup({
        asset: 'NVDA', direction: 'long', type: 'swing',
        conditions: [{ id: 'c1', text: 'SMH leading' }],
        scenarios: [
            { id: 's1', name: 'false break', entry_legs: [{ price: 238.6, quantity: 100 }],
              stop_legs: [{ price: 234.8 }], target_legs: [{ price: 246 }],
              validity: { lower: 234, upper: 244, on_away: 'revise' } },
            { id: 's2', name: 'break and go', entry_legs: [{ price: 244.9, quantity: 60 }],
              stop_legs: [{ price: 241.8 }], target_legs: [{ price: 252 }],
              validity: { lower: 241, upper: 250 } },
        ],
    })
    assert.deepEqual(setupReadiness(two, true).missing, ['runaway answer on break and go'])
})

test('an empty rejects pool warns and never blocks', () => {
    const filled = normalizeSetup({ ...DRAFT, alternatives: [{ archetype: 'breakout', why_not: 'worse fill, no better invalidation' }] })
    assert.deepEqual(setupReadiness(filled, true).warnings, [])
    assert.equal(setupReadiness(normalizeSetup(DRAFT), true).ready, true, 'the warning is not a gate')
    assert.deepEqual(setupReadiness(normalizeSetup(DRAFT), true).warnings, ['no rejected ways in recorded'])
})

test('alternatives survive a normalise round-trip, like the conditions do', () => {
    // The pool is authored ONCE and carried forward on every re-emit, so the normaliser has to be
    // able to read its own output back — otherwise the worksheet empties itself on the next turn.
    const once  = normalizeSetup({ ...DRAFT, alternatives: [{ archetype: 'retest', price: 244, why_not: 'the break has not printed yet' }] })
    const twice = normalizeSetup(once)
    assert.deepEqual(twice.alternatives, once.alternatives)
    assert.equal(twice.scenarios[0].archetype, once.scenarios[0].archetype)
})

test('a challenge entry needs a pass AND a verdict, or it is not a record', () => {
    // `{ pass: 'flip', verdict: null }` would read at confirm as "attacked, inconclusive", when what
    // actually happened is that nobody could tell what came back.
    const out = normalizeChallenges([
        { pass: 'flip', verdict: 'two_sided', at: '2026-09-26T10:00:00Z' },
        { pass: 'flip' },
        { verdict: 'stands' },
        { pass: 'vibes', verdict: 'stands' },
        { pass: 'flip', verdict: 'probably fine' },
        null, 'flip', 42,
    ])
    // `at` is canonicalised like every other stored timestamp — same ISO shape everywhere.
    assert.deepEqual(out, [{ pass: 'flip', verdict: 'two_sided', at: '2026-09-26T10:00:00.000Z' }])
    for (const v of CHALLENGE_VERDICTS) assert.equal(normalizeChallenges([{ pass: 'flip', verdict: v }])[0].verdict, v)
    assert.equal(normalizeChallenges([{ pass: 'flip', verdict: 'stands', at: 'whenever' }])[0].at, null)
})

test('the challenge record keeps the NEWEST three', () => {
    // A verdict about the current levels is worth more than one about levels that have since moved —
    // and a fourth entry means the plan was re-attacked until it gave the wanted answer.
    const five = ['stands', 'two_sided', 'reversed', 'stands', 'two_sided'].map(verdict => ({ pass: 'flip', verdict }))
    assert.deepEqual(normalizeChallenges(five).map(c => c.verdict), ['reversed', 'stands', 'two_sided'])
    assert.deepEqual(normalizeChallenges(null), [])
})

test('the challenge record survives the round trip to Generate', () => {
    // It is read from `raw` so the client's draft can carry it to the save path; the AGENT layer is
    // what stops the model authoring it (mentorAgent.test.js), not this normaliser.
    const once = normalizeSetup({ ...DRAFT, challenges: [{ pass: 'flip', verdict: 'stands', at: '2026-09-26T10:00:00Z' }] })
    assert.deepEqual(normalizeSetup(once).challenges, once.challenges)
})
