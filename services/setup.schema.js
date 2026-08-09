// The `setup` entity contract — normalisation + readiness, in ONE place.
//
// Mentor authors a setup as free-ish JSON; Talos monitors it as a strict shape. This module is
// the seam: it coerces whatever the model emitted into the documented payload (docs/desks/mentor-talos.md
// §3) and derives every server-owned field. Pure — no IO, no DB, no model calls — so both the
// agent (draft preview) and the save path (persist) run the SAME normalisation and can't drift.
//
// Deliberately NOT here: broker / accounts / mode / event_risk. Those bind at Generate from the
// marked account and the event-risk service; see setup.finalize.

import { normalizeTimeframe, VALID_TIMEFRAMES } from './timeframe.service.js'
import { normalizeAssetClass } from './entity/vocabulary.js'
import { cleanConviction } from './conviction.util.js'
import { TRADE_HORIZONS } from './entity/vocabulary.js'

// Coarse → fine. The ladder is a contiguous slice of this, centred on the authored timeframe.
export const TF_RUNGS = ['month', 'week', 'day', '4hr', '2hr', '1hr', '30min', '15min', '5min', '1min']

export const TRADE_MODES  = ['classical', 'smc']

// ─── Conditions ───────────────────────────────────────────────────────────────
//
// A condition is TEXT. There is no taxonomy: the monitor reads the sentence and picks its own
// tools, so an enum here would only ever narrow what can be checked (docs/desks/mentor-talos.md
// §2). What stays structured is the little that CODE needs:
//
//   id           the per-condition ledger key — the monitor answers {id, met, note}, so a verdict
//                maps back to a specific declared condition and two wakes are comparable.
//   weight       primary = the trigger itself · confirming = supports, doesn't veto.
//   mode         Mentor's RECORD of the build conversation, not a re-derivation: did the user give
//                a hard test ("below VWAP") or hand the judgment over ("how the price action
//                looks")? Both are legitimate. It changes the monitor's VOICE and the confidence
//                on a failed check — never the verdict.
//   persistence  latching = an event; once true it stays true, so re-checking is waste AND a
//                correctness risk (a re-run search can return a different answer and talk the
//                model out of a settled fact). live = a state that can flip; re-check every wake.
export const CONDITION_WEIGHTS     = ['primary', 'confirming']
export const CONDITION_MODES       = ['measured', 'discretionary']
export const CONDITION_PERSISTENCE = ['live', 'latching']

/** What happens when price leaves the validity range. Authored, never assumed. */
export const ON_BREAK = ['revise', 'close', 'notify_only']

/** Cap on symbols a setup may pull the monitor onto — free text can name anything. */
const MAX_REFERENCED_SYMBOLS = 6

// Poll cadence (minutes) by horizon: {min, max}. `min` is the floor a self-chosen next_check_min
// clamps up to; `max` the ceiling it clamps down to. Wider horizon → lazier loop.
const CADENCE_BY_TYPE = {
    'intraday':  { min: 2,   max: 15 },
    'day':       { min: 5,   max: 60 },
    'swing':     { min: 30,  max: 240 },
    'long term': { min: 240, max: 1440 },
}
const DEFAULT_CADENCE = CADENCE_BY_TYPE.swing

// How many rungs either side of the authored timeframe the monitor may reach for. Bounded so an
// intraday setup can't have its assessment wander onto a monthly chart.
const LADDER_SPAN = 2

/**
 * The timeframes the monitor's tools may request, coarse→fine. A contiguous window of TF_RUNGS
 * centred on `timeframe` (±LADDER_SPAN), clamped at both ends of the rung list.
 * Unknown/absent timeframe → a sane day-trade ladder.
 */
export function buildLadder(timeframe) {
    const tf = normalizeTimeframe(timeframe)
    const i  = TF_RUNGS.indexOf(tf)
    if (i === -1) return ['1hr', '30min', '15min']
    return TF_RUNGS.slice(Math.max(0, i - LADDER_SPAN), Math.min(TF_RUNGS.length, i + LADDER_SPAN + 1))
}

/** Poll cadence bounds for a horizon. Unknown → swing. */
export function buildCadence(type) {
    return { ...(CADENCE_BY_TYPE[type] ?? DEFAULT_CADENCE) }
}

/**
 * A number, where ABSENT means absent.
 *
 * `Number(null)` is **0**, and that is a live trap here rather than a curiosity: this module
 * re-normalises documents it has already normalised — every streamed turn, every edit, every
 * Generate — and its own output writes an absent edge as `null`, not `undefined`. So the naive
 * `Number(raw.approach)` read a missing away-pivot as 0 on the SECOND pass. For a long that means
 * "price has run away above 0", which is permanently true: the coherence check then refuses the
 * setup for an edge the author never wrote, and the runaway gate would fire on every wake. The same
 * one-character trap turned an absent `validity.lower` into a floor of 0, i.e. "below the stop".
 *
 * Found by a live verification run that refused to Generate a plan with nothing wrong with it.
 */
const num = (v) => (v == null || v === '' ? NaN : Number(v))

// ─── Zones ────────────────────────────────────────────────────────────────────

/**
 * Coerce one zone. A zone is a band with a quantity; anything that can't produce two finite,
 * correctly-ordered edges is dropped by the caller (returns null).
 *
 * Tolerant by design — the model reliably emits the numbers and unreliably emits their order,
 * so `lower`/`upper` are sorted rather than rejected. A single `price` (a point, not a band) is
 * accepted and collapsed to a zero-width zone: better to monitor an exact level than to silently
 * drop the user's stop.
 */
export function normalizeZone(z, i, prefix) {
    if (!z || typeof z !== 'object') return null

    let lo = num(z.lower)
    let hi = num(z.upper)

    // Point emitted instead of a band → zero-width zone at that price.
    if (!Number.isFinite(lo) && !Number.isFinite(hi)) {
        const p = num(z.price)
        if (!Number.isFinite(p)) return null
        lo = hi = p
    } else if (!Number.isFinite(lo)) lo = hi
    else if (!Number.isFinite(hi)) hi = lo

    if (lo > hi) [lo, hi] = [hi, lo]

    const qty = num(z.quantity)
    return {
        id:       typeof z.id === 'string' && z.id.trim() ? z.id.trim() : `${prefix}${i + 1}`,
        lower:    lo,
        upper:    hi,
        quantity: Number.isFinite(qty) && qty > 0 ? qty : null,
        note:     typeof z.note === 'string' && z.note.trim() ? z.note.trim() : null,
    }
}

export function normalizeZones(arr, prefix) {
    if (!Array.isArray(arr)) return []
    return arr.map((z, i) => normalizeZone(z, i, prefix)).filter(Boolean)
}

/**
 * A SCENARIO's size — the sum of its own entry zones, which in v1 is exactly one zone, so this is
 * simply "the position this premise takes".
 *
 * NEVER SUMMED ACROSS SCENARIOS. Scenarios are rivals, not legs: the first to fulfil takes the whole
 * trade and the others die. The predecessor of this function summed every entry zone on the document
 * while the monitor fired ONCE for that total — so two rival zones of 100 placed 200. Scaling in
 * (several entries inside ONE scenario) is what this sum is reserved for; readiness blocks it until
 * per-leg execution exists.
 */
export function scenarioQuantity(entryZones) {
    const sum = (entryZones ?? []).reduce((acc, z) => acc + (Number(z?.quantity) || 0), 0)
    return sum > 0 ? sum : null
}

// ─── conditions[] ─────────────────────────────────────────────────────────────

/** Upper-cased, de-duplicated, capped ticker list. Shared by `referenced_symbols`. */
export function normalizeSymbols(arr, cap = MAX_REFERENCED_SYMBOLS) {
    if (!Array.isArray(arr)) return []
    return [...new Set(arr.filter(s => typeof s === 'string' && s.trim()).map(s => s.toUpperCase().trim()))].slice(0, cap)
}

/**
 * Coerce the monitor's instruction sheet. A condition with no `text` is dropped — there is nothing
 * for the monitor to check, which is worse than an absent condition.
 *
 * IDS MUST BE STABLE ACROSS RE-EMITS. The monitor latches resolved conditions by id
 * (`monitor_state.conditions`), so an id that shifts when the model drops one condition would
 * attach a past finding to a different condition. An authored id therefore always wins; the
 * positional fallback keys off the ORIGINAL index (not the surviving count) so a dropped entry
 * doesn't renumber its neighbours; and collisions are suffixed rather than silently merged.
 */
export function normalizeConditions(arr, { used, prefix = 'c' } = {}) {
    if (!Array.isArray(arr)) return []
    // Ids are unique across the WHOLE document, not just this list: the resolved-condition ledger
    // (`monitor_state.conditions`) is ONE map for the setup, so a scenario's condition sharing an id
    // with a root condition would let one latch answer for the other. Callers thread a single `used`
    // set through the root tier and every scenario; `prefix` keeps the positional fallback readable
    // (`c1` at the root, `s2c1` inside the second scenario).
    const used_ = used ?? new Set()

    const claim = (wanted, i) => {
        let id = wanted || `${prefix}${i + 1}`
        if (used_.has(id)) {
            let n = 2
            while (used_.has(`${id}_${n}`)) n++
            id = `${id}_${n}`
        }
        used_.add(id)
        return id
    }

    return arr.reduce((out, c, i) => {
        if (!c || typeof c !== 'object') return out
        const text = typeof c.text === 'string' ? c.text.trim() : ''
        if (!text) return out

        out.push({
            id:          claim(typeof c.id === 'string' ? c.id.trim() : '', i),
            text,
            weight:      CONDITION_WEIGHTS.includes(c.weight) ? c.weight : 'confirming',
            // Unstamped → 'discretionary'. Claiming 'measured' without the conversation having
            // established a test would overstate how hard the check is.
            mode:        CONDITION_MODES.includes(c.mode) ? c.mode : 'discretionary',
            // Unstamped → 'live'. Re-checking something that didn't need it costs a call;
            // caching something that did is a WRONG ANSWER, so the safe default re-checks.
            persistence: CONDITION_PERSISTENCE.includes(c.persistence) ? c.persistence : 'live',
        })
        return out
    }, [])
}

// ─── validity ─────────────────────────────────────────────────────────────────

/**
 * The price range outside which the setup is no longer worth watching — the second thing the cheap
 * arithmetic gate asks on every wake, alongside "is price in a zone?".
 *
 * The two edges are NOT symmetric, and flattening them loses the point. For a long:
 *   • below `lower`   → invalidation. Structure broke the other way; the premise is gone.
 *   • above `approach`→ "ran away, not coming". The setup was never wrong — it was missed.
 * Mirrored for a short. `approach` therefore sits OUTSIDE the envelope, on the away side.
 *
 * Absent (or with neither edge) → null, and the setup simply has no validity gate. Optional in v1:
 * a setup without one behaves exactly as it does today.
 */
export function normalizeValidity(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    let lower = num(raw.lower)
    let upper = num(raw.upper)
    if (!Number.isFinite(lower)) lower = null
    if (!Number.isFinite(upper)) upper = null
    if (lower == null && upper == null) return null
    if (lower != null && upper != null && lower > upper) [lower, upper] = [upper, lower]

    const approach = num(raw.approach)
    return {
        lower,
        upper,
        approach:  Number.isFinite(approach) ? approach : null,
        // Which rung's CLOSE decides. A wick through the line must not kill a setup, and an
        // intraday wick must not kill a swing setup.
        timeframe: normalizeTimeframe(raw.timeframe) || null,
        on_break:  ON_BREAK.includes(raw.on_break) ? raw.on_break : 'revise',
    }
}

// ─── scenarios[] ──────────────────────────────────────────────────────────────
//
// A PRICE ZONE IS A SCENARIO (docs/desks/mentor-talos.md). A long at 100 on a false break and
// a long at 104 on a break-and-go are not two legs of one entry — they are two premises that happen
// to share a ticker and a direction, and they disagree about everything else: what confirms them,
// where the stop belongs, and what price would prove them dead. So each scenario owns its own
// entry / stop / targets, its own conditions and its own validity range.
//
// RIVALS, NOT LEGS. The first scenario to fulfil takes the WHOLE trade; the rest die with it.
// Quantities are never added across scenarios (see scenarioQuantity).
//
// The setup keeps a root `conditions[]` for what is true whatever prints — the FDA approval, the
// regime read. A wake judges `root ∪ the armed scenario's`, so shared conditions are authored once
// and never copied.

/** How a scenario is named in a message to the user. Its own name if it has one, else its id. */
export function scenarioLabel(sc) {
    const n = typeof sc?.name === 'string' ? sc.name.trim() : ''
    return n || sc?.id || 'scenario'
}

/**
 * One scenario. `direction` comes from the setup because a premise cannot be long while its parent
 * is short — direction is the one thing rivals must agree on (it is what makes them rivals rather
 * than two setups).
 *
 * Zone ids are prefixed with the scenario's id, so they stay unique document-wide and
 * `armed_zone_id` still resolves to exactly one zone. An authored id always wins, which is what
 * lets a legacy document keep its `ez1`/`sz1` ids through the wrap.
 */
export function normalizeScenario(raw, i, { direction = null, used, ids } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    const taken = ids ?? new Set()
    let id = (typeof raw.id === 'string' && raw.id.trim()) ? raw.id.trim() : `s${i + 1}`
    if (taken.has(id)) { let n = 2; while (taken.has(`${id}_${n}`)) n++; id = `${id}_${n}` }
    taken.add(id)

    const entry_zones = normalizeZones(raw.entry_zones, `${id}e`)
    const stop_zones  = normalizeZones(raw.stop_zones,  `${id}s`)
    const tp_zones    = normalizeZones(raw.tp_zones,    `${id}t`)

    const sc = {
        id,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
        entry_zones,
        stop_zones,
        tp_zones,
        conditions: normalizeConditions(raw.conditions, { used, prefix: `${id}c` }),
        validity:   normalizeValidity(raw.validity),
        quantity:   scenarioQuantity(entry_zones),
        rr:         null,
    }
    // Derived per scenario, from ITS OWN legs. A setup-wide r:r would price the false break's entry
    // against the breakout's target and mean neither.
    const authored = num(raw.rr)
    sc.rr = computeRR({ direction, ...sc }) ?? (Number.isFinite(authored) ? authored : null)
    return sc
}

export function normalizeScenarios(arr, { direction = null, used } = {}) {
    if (!Array.isArray(arr)) return []
    const ids = new Set()
    return arr.map((s, i) => normalizeScenario(s, i, { direction, used, ids })).filter(Boolean)
}

/**
 * THE ONE PLACE THAT KNOWS THE PRE-SCENARIO SHAPE. A document authored before scenarios carries its
 * zones and its validity range at the root; it becomes a single implicit scenario so every other
 * module can read scenarios and nothing else.
 *
 * Its entry zones are kept together in that one scenario — verbatim today's behaviour, including the
 * summed quantity — rather than split into rivals, because splitting would silently re-price a live
 * plan. Readiness will refuse to ARM such a setup until it is re-drawn as one scenario per premise,
 * which is the honest outcome: that shape is the double-count bug.
 *
 * Delete this when no pre-scenario documents remain.
 */
function _scenarioSource(raw) {
    if (Array.isArray(raw?.scenarios) && raw.scenarios.length) return raw.scenarios
    const legacy = raw?.entry_zones ?? raw?.stop_zones ?? raw?.tp_zones ?? raw?.validity
    if (!legacy) return []
    return [{
        id: 's1',
        name: null,
        entry_zones: raw.entry_zones,
        stop_zones:  raw.stop_zones,
        tp_zones:    raw.tp_zones,
        validity:    raw.validity,
        conditions:  [],
        rr:          raw.rr,
    }]
}

/** The scenario a document is currently acting on: the armed one, else the first authored. */
export function pickScenario(setup, id = null) {
    const list = setup?.scenarios ?? []
    if (!list.length) return null
    return (id ? list.find(s => s.id === id) : null) ?? list[0]
}

/**
 * THE EXECUTION PROJECTION — a scenario's legs, flattened onto the fields the rest of the app has
 * always read (docs/desks/mentor-talos.md).
 *
 * `entry_zones` / `stop_zones` / `tp_zones` / `quantity` are NOT setup-private: they are the shape
 * the `call` kind uses too, and every kind-blind consumer reads them flat — protectionPlan's
 * routeSetupZones, the order plan, tradeCapture, the watch row. So scenarios stay the authored and
 * monitored model, and the winning scenario is stamped down here when it arms. Execution never
 * learns that scenarios exist.
 *
 * Pre-arm the projection is the FIRST scenario — the primary, which Mentor authors first. The row
 * shows every scenario (toWatchRow) so a second premise is never hidden behind this one. Pure.
 */
export function projectScenario(setup, id = null) {
    const sc = pickScenario(setup, id)
    return {
        entry_zones: sc?.entry_zones ?? [],
        stop_zones:  sc?.stop_zones  ?? [],
        tp_zones:    sc?.tp_zones    ?? [],
        validity:    sc?.validity    ?? null,
        quantity:    sc?.quantity    ?? null,
        rr:          sc?.rr          ?? null,
    }
}

/**
 * A scenario as the pure per-plan helpers want it — they ask for `direction` + legs + `validity`,
 * which is exactly a scenario plus the one field it inherits. Lets computeRR, validityProblems and
 * validityBreach run per scenario with no second implementation.
 */
export function scenarioView(setup, sc) {
    return { direction: setup?.direction ?? null, ...(sc ?? {}) }
}

/** The conditions a wake judges: the setup-wide tier plus the armed scenario's own. Pure. */
export function declaredConditions(setup, sc = null) {
    return [...(setup?.conditions ?? []), ...(sc?.conditions ?? [])]
}

// ─── ISO bounds ───────────────────────────────────────────────────────────────

// Accept an ISO string (or ms) and return a normalised Z-ISO string. Invalid → null, so a
// garbage date can never become a live time gate.
function isoOrNull(v) {
    if (v == null || v === '') return null
    const ms = typeof v === 'number' ? v : Date.parse(v)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

// ─── The whole setup ──────────────────────────────────────────────────────────

/**
 * Normalise a model-authored setup into the documented payload shape. Never throws: a malformed
 * field degrades to null/[] rather than rejecting the draft, because this also runs on every
 * streamed turn to render the live worksheet — a half-built setup is the normal case, not an error.
 *
 * Server-derived fields (`ladder`, `cadence`, `quantity`) are always recomputed here, so an
 * attempt by the model to author them is overwritten rather than trusted.
 */
export function normalizeSetup(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    const type      = TRADE_HORIZONS.includes(raw.type) ? raw.type : null
    const timeframe = VALID_TIMEFRAMES.has(normalizeTimeframe(raw.timeframe)) ? normalizeTimeframe(raw.timeframe) : null
    const direction = raw.direction === 'short' ? 'short' : raw.direction === 'long' ? 'long' : null

    // ONE id space for the whole document — the root tier first, then each scenario, so the single
    // resolved-condition ledger can never have two conditions answering to the same key.
    const used      = new Set()
    const conditions = normalizeConditions(raw.conditions, { used })
    const scenarios  = normalizeScenarios(_scenarioSource(raw), { direction, used })

    return {
        asset:       typeof raw.asset === 'string' ? raw.asset.toUpperCase().trim() : '',
        // Canonicalised at the door: market hours, event risk and the monitors all branch on
        // this, and each had grown its own synonym map. An unknown value becomes null, which
        // every consumer already reads as "fall back to the symbol heuristic".
        asset_class: normalizeAssetClass(raw.asset_class),
        direction,
        type,
        trade_mode:  TRADE_MODES.includes(raw.trade_mode) ? raw.trade_mode : 'classical',
        timeframe,
        active_from: isoOrNull(raw.active_from),
        valid_until: isoOrNull(raw.valid_until),

        thesis:     typeof raw.thesis === 'string' ? raw.thesis.trim() : '',
        // The setup-wide tier. Each scenario carries its own trigger; these are what holds whichever
        // one prints.
        conditions,
        // The symbols a condition may pull the monitor onto, beyond the setup's own asset. Free
        // text can name anything; the fetch budget stays bounded by what Mentor extracted at build.
        referenced_symbols: normalizeSymbols(raw.referenced_symbols),

        // The authored plan: one entry per premise, each owning its legs and its death line.
        scenarios,

        conviction: cleanConviction(raw.conviction) || null,

        // Server-derived — recomputed every time, never taken from the model. `entry_zones`,
        // `stop_zones`, `tp_zones`, `validity`, `quantity` and `rr` are the EXECUTION PROJECTION of
        // one scenario (projectScenario): pre-arm the first, and re-stamped by Talos to the armed
        // one when a zone trips. Authoring them directly does nothing — scenarios are the source.
        ...projectScenario({ scenarios }, raw.armed_scenario_id ?? null),
        ladder:   buildLadder(timeframe),
        cadence:  buildCadence(type),
    }
}

// ─── Readiness ────────────────────────────────────────────────────────────────

/**
 * Can this setup be generated? Mirrors the prompt's stated gate exactly, so the button and the
 * agent's own claim about readiness can't disagree.
 *
 * `hasAccount` is passed in rather than read off the setup: the marked account lives in client
 * state during the build (it isn't bound onto the payload until Generate).
 *
 * Returns the blocking reasons, so the UI can say WHICH thing is missing instead of a dead button.
 */
export function setupReadiness(setup, hasAccount = false) {
    const missing = []
    if (!setup?.asset)      missing.push('asset')
    if (!setup?.direction)  missing.push('direction')
    if (!setup?.type)       missing.push('horizon')

    const list  = setup?.scenarios ?? []
    const multi = list.length > 1
    const root  = setup?.conditions ?? []

    if (!list.length) missing.push('scenario')

    for (const sc of list) {
        // With two premises in play, "missing stop zone" is ambiguous — say WHICH one.
        const at = (what) => (multi ? `${what} on ${scenarioLabel(sc)}` : what)

        if (!(sc.entry_zones?.length)) missing.push(at('entry zone'))
        // Two entries in ONE scenario is scaling in, and execution fires once for the scenario's
        // whole size — so the position would be both legs while only one zone printed. Two PREMISES
        // are two scenarios; two legs of one premise wait for per-leg execution.
        else if (sc.entry_zones.length > 1) missing.push(at('a single entry zone (two premises are two scenarios; scaling in is not supported yet)'))

        if (!(sc.stop_zones?.length)) missing.push(at('stop zone'))
        if (!Number.isFinite(sc.quantity) || sc.quantity <= 0) missing.push(at('quantity'))

        // PRESENCE only, counting the root tier. Whether a condition is *checkable* is Mentor's gate
        // and lives in the prompt — code can't read a sentence and say how anyone would know. But a
        // scenario with nothing to check arms blind: Talos falls through to `judge on price structure
        // at the zone alone` and the premise never gets tested. A scenario needs no trigger of its
        // own when the root carries one.
        if (!root.length && !(sc.conditions?.length)) missing.push(at('condition'))
    }
    if (!list.length && !root.length) missing.push('condition')

    if (!hasAccount) missing.push('trading account')

    const problems = validityProblems(setup)
    return { ready: missing.length === 0 && problems.length === 0, missing, problems }
}

/**
 * Coherence between the validity range and the plan it is supposed to outlive. A range that
 * contradicts the stop is worse than no range: it reports a setup as "still valid" at a price where
 * its own plan is already dead (long entry 238 / stop 234.8 / validity.lower 230 → at 234 the stop
 * is blown but the setup still reads live). Nothing checked this before, because nothing had a
 * range to check.
 *
 * Returns human-readable slugs, not booleans, so the button can say WHICH thing is wrong — and it
 * lives here rather than only in the Generate gate so the FE's readiness and the server's refusal
 * cannot disagree.
 *
 * Pure. An absent validity range is not a problem (optional in v1).
 */
export function validityProblems(setup) {
    const list  = setup?.scenarios ?? []
    const multi = list.length > 1
    return list.flatMap(sc => rangeProblems(scenarioView(setup, sc))
        .map(p => (multi ? `${scenarioLabel(sc)}: ${p}` : p)))
}

/**
 * The coherence check for ONE plan — a scenario, or anything else carrying `direction` + `validity`
 * + `stop_zones`. Per scenario because the range and the stop it must outlive both belong to the
 * same premise: checking the false break's floor against the breakout's stop compares two different
 * trades. Pure.
 */
export function rangeProblems(setup) {
    const v = setup?.validity
    if (!v) return []
    const out  = []
    const long = setup?.direction === 'long'

    // The far stop edge = the most risk the plan admits. Beyond it the trade is dead by its own
    // terms, so the validity floor/ceiling must not sit further out than that.
    const stopEdges = (setup?.stop_zones ?? []).flatMap(z => [z?.lower, z?.upper]).filter(Number.isFinite)
    if (stopEdges.length) {
        const stopFar = long ? Math.min(...stopEdges) : Math.max(...stopEdges)
        if (long  && v.lower != null && v.lower < stopFar) out.push('validity floor sits below the stop')
        if (!long && v.upper != null && v.upper > stopFar) out.push('validity ceiling sits above the stop')
    }

    // The away pivot must be OUTSIDE the envelope, on the side price would run away to — inside, it
    // can never fire, which is how the legacy invalidation monitor ended up warning and ignoring.
    if (v.approach != null) {
        const inside = (v.lower == null || v.approach >= v.lower) && (v.upper == null || v.approach <= v.upper)
        if (inside) out.push('away pivot sits inside the validity range')
        else if (long  && v.upper != null && v.approach < v.upper) out.push('away pivot is below the range on a long')
        else if (!long && v.lower != null && v.approach > v.lower) out.push('away pivot is above the range on a short')
    }
    return out
}

// ─── Reward-to-risk ───────────────────────────────────────────────────────────

/**
 * Reward-to-risk from the PESSIMISTIC fill, per docs/desks/mentor-talos.md
 *
 * SCOPED TO ONE PLAN — a scenario (via scenarioView), or the projected document, both of which carry
 * `direction` + the three zone arrays. Pricing a setup's r:r across scenarios would run one
 * premise's entry to another's target and describe a trade nobody planned.
 *
 * For a long: the worst entry is the zone's UPPER edge (you paid up), risk runs to the LOWEST
 * stop edge (the failsafe rests at the far side), reward to the NEAREST target edge. Mirrored
 * for a short. Every leg deliberately takes its unfavourable side — quoting the midpoint, or the
 * furthest target, would flatter the setup, and the whole point of the rule is that the plan
 * advertises the bad fill.
 *
 * Legs are SELECTED by price, never by array position: the model emits zones in whatever order it
 * reasoned about them, so trusting `tp_zones[0]` to be the first target would quietly hand a
 * multi-target setup the rr of its furthest leg.
 *
 * `entryPrice` overrides the zone edge — that's the LIVE rr at the confirm card, computed from
 * the actual price rather than the plan.
 *
 * Returns null when any leg is missing or risk is zero (an entry inside its own stop).
 */
/**
 * The price a leg is REACHED at, per side. A zone is a band, so which edge counts depends on which
 * way price arrives: a long's stop is hit at the band's `lower`, its target at the band's `lower`
 * too (price rises into the near edge). Mirrored for a short. Pure.
 */
const _edge = (z, isLong) => (isLong ? z?.lower : z?.upper)

/**
 * One entry LEG, folded into the running position. Pure.
 *
 * Scaling in means a position is built from several fills at different prices, so `entry` stops
 * being a single fact and becomes an aggregate: `legs[]` is what actually happened, `size` their
 * sum, and `fill_price` their SIZE-WEIGHTED average.
 *
 * The average is the load-bearing part. `rMultiple` measures from `entry.fill_price`, and it feeds
 * `positionGate`'s adverse and breakeven tiers plus `computeMetrics`' mae/mfe — so a plain mean of
 * the leg prices, or simply keeping the first fill, would misreport R on every wake of every scaled
 * position. Weight by size or the number is fiction.
 *
 * A no-op for a single-leg position: one leg weighted by its own size is that leg's price, which is
 * why this can land before per-leg execution exists.
 */
export function addEntryLeg(entry, leg) {
    // EVERY leg is kept: it happened, and a fill we could not price still added size. Only the
    // AVERAGE is selective.
    const legs = [...(entry?.legs ?? []), leg].filter(Boolean)

    // Size counts any leg with a quantity, priced or not — discarding it would under-report the
    // position, which is the more dangerous direction (the stop would cover less than is held).
    const size = legs.reduce((n, l) => n + (Number(l?.quantity) > 0 ? Number(l.quantity) : 0), 0)

    // The average weights only legs carrying BOTH a price and a size. `price != null` is checked
    // before coercion because Number(null) is 0, not NaN — without it an unpriced leg enters as a
    // free share and halves the reported entry, misreporting R on every subsequent wake.
    const priced = legs.filter(l => l?.price != null && Number.isFinite(Number(l.price)) && Number(l?.quantity) > 0)
    const weight = priced.reduce((n, l) => n + Number(l.quantity), 0)

    // Nothing weighable — the last price we DO have is the honest answer, and it is what the
    // single-leg path has always written when sizing was unresolved.
    const lastPriced = [...legs].reverse().find(l => l?.price != null && Number.isFinite(Number(l.price)))
    const price = weight > 0
        ? priced.reduce((n, l) => n + Number(l.price) * Number(l.quantity), 0) / weight
        : Number(lastPriced?.price ?? NaN)

    return {
        legs,
        size:       size > 0 ? size : (entry?.size ?? null),
        fill_price: Number.isFinite(price) ? Math.round(price * 1e6) / 1e6 : null,
    }
}

/**
 * The working stop: the WIDEST stop edge, i.e. the most risk the plan admits. Null when none is
 * authored. Pure.
 *
 * Selected by price, never by array position — the model emits zones in whatever order it reasoned
 * about them, so `stop_zones[0]` is not the far one.
 */
export function stopEdge(setup) {
    const isLong = setup?.direction === 'long'
    const edges  = (setup?.stop_zones ?? []).map(z => _edge(z, isLong)).filter(Number.isFinite)
    if (!edges.length) return null
    return isLong ? Math.min(...edges) : Math.max(...edges)
}

/**
 * Target edges NEAREST-FIRST — the order price will actually reach them, which is the order a
 * partial ladder fires in. Empty when none is authored. Pure.
 *
 * Same rule as the stop: ordered by price, never by array position. Trusting `tp_zones[0]` would
 * quietly hand a multi-target setup the rr of its furthest leg, and would fire its partials in the
 * order the model happened to type them.
 */
export function targetEdges(setup) {
    const isLong = setup?.direction === 'long'
    const edges  = (setup?.tp_zones ?? []).map(z => _edge(z, isLong)).filter(Number.isFinite)
    return edges.sort((a, b) => (isLong ? a - b : b - a))
}

export function computeRR(setup, entryPrice = null) {
    const isLong = setup?.direction === 'long'
    const entryZone = setup?.entry_zones?.[0]
    if (!entryZone) return null

    const entry   = Number.isFinite(entryPrice) ? entryPrice : (isLong ? entryZone.upper : entryZone.lower)
    const stop    = stopEdge(setup)
    const targets = targetEdges(setup)
    if (stop == null || !targets.length) return null

    const tp = targets[0]   // nearest = least reward
    if (!Number.isFinite(entry)) return null

    const risk   = isLong ? entry - stop : stop - entry
    const reward = isLong ? tp - entry   : entry - tp
    if (!(risk > 0)) return null

    return Math.round((reward / risk) * 100) / 100
}
