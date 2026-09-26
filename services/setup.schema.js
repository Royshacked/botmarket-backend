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
import { MODES } from './analysisModes.js'
import { TF_RUNGS, isFetchableRung, ladderFor, MARKET_CAPS } from './setup.ladder.js'
import { ENTRY_ARCHETYPES, STOP_ANCHORS, TARGET_ANCHORS, normalizeTaxon } from './setup.taxonomy.js'

// The rung VOCABULARY lives in setup.ladder.js, not here. This module is the entity contract and
// consumes rung facts; that one owns what a rung is and which rungs a horizon reaches for. The
// dependency runs one way on purpose — the ladder used to import TF_RUNGS back off this file,
// which is a cycle waiting to bite whoever adds the next import.
export { TF_RUNGS, isFetchableRung }

// The LENS a setup was built through — the same three Kairos offers (kairos.modes MODES), so a
// user hears one vocabulary across both desks. `classical` was the old name for the first one and
// meant exactly what `discretionary` means: classical price action, indicators confirming rather
// than leading.
//
// Migration is free for the same reason the condition rename was: a stored `classical` is no
// longer in the set, so it falls to the default below — which IS `discretionary`. Same lens, new
// name, no rewrite.
// The words themselves are analysisModes' — "the shared vocabulary, not one desk's", as that file
// puts it. This was a second copy of the identical three, which is the arrangement where one side
// gains a lens and the other silently rejects it as unknown. The NAME stays: a setup's field is
// `trade_mode`, and reading `TRADE_MODES.includes(raw.trade_mode)` at the call site says what is
// being checked. (tests/unit/modeCollision.test.js holds the two in step.)
export const TRADE_MODES  = MODES

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
// `judgment`, not `discretionary`. The lens set is about to become discretionary|smc|institutional
// (kairos.modes already spells it that way), and a document carrying `mode` for the LENS and `mode`
// for a CONDITION with the same value meaning two unrelated things is a trap laid for whoever reads
// it next. The lens names are user-facing and win; this one moves.
//
// MIGRATION IS FREE. A stored condition saying 'discretionary' is no longer in the set, so it falls
// to the default below — which IS 'judgment', the same meaning under the new name. Nothing to
// rewrite and nothing that reads wrong in the meantime.
export const CONDITION_MODES       = ['measured', 'judgment']
export const CONDITION_PERSISTENCE = ['live', 'latching']

/** What happens when price leaves the validity range. Authored, never assumed. */
export const ON_BREAK = ['revise', 'close', 'notify_only']

/**
 * What happens when price leaves on the FAVOURABLE side — the away edge, which until now had a
 * detector and nothing authored behind it (docs/design/mentor-challenge.md §3).
 *
 *   revise — tell the user and open Mentor with the plan loaded. The level moved, so the redraw is
 *            where a continuation gets MEASURED; nothing here authors one.
 *   pass   — they decided to let a missed trade go. Told once, asked nothing.
 *
 * TWO, not four. `close` has no meaning on this edge (a runaway never kills a setup — price can
 * come back), and a pre-authored `continuation` was considered and dropped: no entry fires without
 * the user's confirm, so arming the sibling in advance buys no action while they sleep, only a
 * staler price than the redraw would measure.
 *
 * NO DEFAULT, unlike `on_break` — see normalizeValidity.
 */
export const ON_AWAY = ['revise', 'pass']

/** Cap on symbols a setup may pull the monitor onto — free text can name anything. */
const MAX_REFERENCED_SYMBOLS = 6

/**
 * Caps on the rejects pool. FIVE entries because the list is read at a glance and a sixth is noise;
 * one CLAUSE each because `alternatives` rides every worksheet re-emit, and a paragraph per reject
 * is a real per-turn output cost for something authored once.
 */
const MAX_ALTERNATIVES = 5
const MAX_WHY_NOT      = 200

// ─── Pace ── which rungs Talos is READ on ──────────────────────────────
//
// READING AND PACING ARE DIFFERENT PERMISSIONS, and until 2026-09-23 one derived field did both.
// `ladder` was the authored timeframe ±2 rungs, and it fenced BOTH what the monitor could look at
// and how often it woke. The first half was already wrong and had been deleted at the tool boundary
// (monitoring/assessTools.js) — Talos may chart anything its conditions name. The second half is
// real and stays, because the rung IS the wake clock and therefore the bill.
//
// `pace_rungs` is the AUTHORED answer, and it is never empty (docs/design/talos-two-tier.md):
//
//   the user named rungs  →  exactly those. Absolutely.
//   nobody named any      →  ladderFor(horizon, marketCap)
//
// NAMED RUNGS ARE THE USER FORCING THEIR OWN APPROACH. Mentor may not add to them, Talos may not
// roam outside them, and there is no cap on how many may be named — a cap would be the system
// overruling the user, which is the one thing this field exists to prevent. Mentor may argue in the
// conversation and must then file what was said, exactly as it must with a price.
//
// This costs nothing in reach: pacing decides when Talos is READ, never what it may LOOK AT.
//
// `timeframe` is now purely the PREMISE — the chart the plan was drawn on. It no longer constrains
// pace, which is what makes "drawn on the daily, triggered on the 15min" expressible at last:
// { timeframe: 'day', pace_rungs: ['15min'] }. Under ±2 that setup could not exist.

/**
 * The authored pace set: normalised, fetchable-only, deduped, coarse→fine. Empty in, empty out —
 * `normalizeSetup` is what falls back to the ladder, because only it knows the horizon and the cap.
 * Pure.
 */
export function normalizePaceRungs(raw) {
    const want = new Set((Array.isArray(raw) ? raw : []).map(normalizeTimeframe).filter(isFetchableRung))
    return TF_RUNGS.filter(r => want.has(r))
}

/**
 * The rungs this setup may be paced on, coarse→fine. Never empty: a document that somehow carries
 * none falls to its premise, then to the horizon's ladder. Pure.
 */
export function paceRungs(setup) {
    const stored = normalizePaceRungs(setup?.pace_rungs)
    if (stored.length) return stored
    const premise = normalizePaceRungs([setup?.timeframe])
    return premise.length ? premise : ladderFor(setup?.type, setup?.market_cap, setup?.timeframe)
}

/**
 * Resolve a requested pace rung: itself when this setup may be read on it, else null so the caller
 * owns the fallback. Membership, and nothing else — there is no floor under a ladder. Pure.
 */
export function resolveRung(tf, setup) {
    const want = normalizeTimeframe(tf)
    return want && paceRungs(setup).includes(want) ? want : null
}

// ─── Tiers — which read runs on a candle ──────────────────────────────────────
//
// `read_mode`, never `mode`: a setup's `mode` is the WORKSPACE (live | paper | manual), stamped at
// Generate, and one key meaning two things is the trap the condition-`mode` rename exists to avoid.

/**
 * `cheap_then_expensive` and `expensive_then_cheap` are the same machine from different starting
 * points; which one a setup starts in falls out of what its conditions need, so nobody authors it.
 */
export const READ_MODES = [
    'cheap_only',            // every close is a cheap read; never escalates
    'expensive_only',        // every close is a full read
    'cheap_then_expensive',  // cheap watches; `fired` or `unknown` escalates
    'expensive_then_cheap',  // expensive until the structural conditions settle, then cheap
    'both',                  // cheap every close AND expensive on its own declared cadence
]

/**
 * The opening mode, read off the conditions rather than asked for. A `measured` condition names a
 * test numbers can apply; a `judgment` one hands the call to whoever is looking. So:
 *
 *   nothing but measured   → cheap_only            the numbers are the whole question
 *   nothing but judgment   → expensive_only        nothing a cheap read could settle
 *   judgment that LATCHES  → expensive_then_cheap  a structural precondition, then arithmetic
 *   otherwise              → cheap_then_expensive  the default
 *
 * Talos owns it after the first read; Mentor only sets where it starts, because Mentor does not
 * know what will happen. Pure.
 */
export function defaultReadMode(setup) {
    const all = declaredConditions(setup, setup?.scenarios?.[0] ?? null)
    if (!all.length) return 'cheap_then_expensive'

    const judgment = all.filter(c => c.mode === 'judgment')
    if (!judgment.length) return 'cheap_only'
    if (judgment.length === all.length) return 'expensive_only'
    // A judgment condition that latches is a precondition: once settled it never needs eyes again,
    // and what is left is arithmetic. That is the shape "false break, then reclaim VWAP" has.
    if (judgment.every(c => c.persistence === 'latching')) return 'expensive_then_cheap'
    return 'cheap_then_expensive'
}

// ─── The premise ──────────────────────────────────────────────────────────────
//
// IS THE MAP STILL TRUE — asked separately from "is this the moment", because they are different
// questions and a read can answer them differently. Until 2026-09-23 the only way to say "the
// thesis is rotting" was a verdict that also acted on it (`stand_aside`, `edit`), so a read that
// wanted to keep waiting while flagging decay had no way to say so, and the journal showed nothing.
//
//   intact   — the plan still describes what price is doing
//   damaged  — the premise is hurt; this may not be a trade any more
//   stale    — the levels no longer describe the chart; it wants re-drawing
//
// ABSENCE MEANS `intact`, and deliberately so: that is exactly today's behaviour, where nothing
// flags anything. A read that does not raise a concern has not raised one.
export const PREMISE_STATES = ['intact', 'damaged', 'stale']

/** The premise a read reported. Unknown/absent → `intact`. Pure. */
export function normalizePremise(raw) {
    return PREMISE_STATES.includes(raw) ? raw : 'intact'
}

/** Most indicators one cheap read computes. Past a handful it is not watching, it is hedging. */
const MAX_WATCH_INDICATORS = 6

/**
 * What the cheap reads compute until the next expensive one. Written by the EXPENSIVE read and
 * rewritten whole each time, exactly as guards are — what it does not re-declare is forgotten.
 *
 * NULL IS A REAL ANSWER, not a gap: it means no numbers-only pass could usefully check anything, so
 * the setup sleeps entirely until its next expensive read or a guard fires. A read watching a
 * head-and-shoulders form says exactly this. Pure.
 */
export function normalizeWatch(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const rung = normalizeTimeframe(raw.rung)
    if (!isFetchableRung(rung)) return null
    const indicators = [...new Set(
        (Array.isArray(raw.indicators) ? raw.indicators : [])
            .filter(s => typeof s === 'string' && s.trim())
            .map(s => s.trim().toLowerCase()))].slice(0, MAX_WATCH_INDICATORS)
    return { rung, indicators }
}

// ─── Guards — the model's own wake conditions ─────────────────────────────────
//
// docs/design/talos-per-candle.md. Talos is read on every candle close of the rung it watches;
// a guard is the PRICE at which it wants to be woken ahead of that — the level that would change
// its answer now rather than at the close. Code evaluates them for free on a fast sweep against
// the RANGE since the last pass, so a level touched and left between two sweeps still fires.
//
//   { price: 311.5, direction: 'above', means: 'entry' }
//
// There is no time term. The candle close is the timer and the backstop both; a guard that says
// "look again in thirty minutes" is asking for what the next candle gives anyway.

/** What a price crossing MEANS, so a wake arrives knowing which read it is doing. */
export const GUARD_MEANINGS = ['entry', 'invalidation', 'manage']
/**
 * Which way a level has to be crossed.
 *
 * `any` is a TOUCH — the range straddles the level, whichever side price came from — and it is not
 * a lazy default. It is the right answer whenever the level matters more than the approach: a
 * pullback entry can be reached from either side and a model should not have to guess which.
 * `above`/`below` are for a level that only means something crossed one way.
 */
export const GUARD_DIRECTIONS = ['above', 'below', 'any']
/** Most levels one read may arm. A model that wants nine is not watching, it is hedging. */
const MAX_GUARDS = 6

/**
 * Hold a read's requested guards to what is legal. The model asks; the server decides. Same
 * division `clampRung` draws, for the same reason — a rule that lives only in a prompt is a rule
 * the model drops the moment the conversation gets interesting. Pure.
 *
 * A guard without a finite price is dropped: there is nothing to evaluate. (Guards written before
 * this design carried a time term; those fall out here on the first read that rewrites the set.)
 *
 * @param {Array}   raw    what the model emitted
 * @param {?number} price  the live price, for the direction inference and the already-true check
 */
export function clampGuards(raw, price = null) {
    const out = []
    for (const g of Array.isArray(raw) ? raw : []) {
        if (!g || typeof g !== 'object' || Array.isArray(g)) continue

        const lvl = num(g.price)
        if (!Number.isFinite(lvl) || lvl <= 0) continue

        const direction = GUARD_DIRECTIONS.includes(g.direction)
            ? g.direction
            // Unstamped → inferred from where price actually is, because a level with no side is
            // not a crossing, it is a number. Falls back to a TOUCH when price is unknown: firing
            // on either approach is the safe error, since the cost is one read and the cost of
            // guessing the wrong side is a move nobody saw.
            : (Number.isFinite(price) ? (lvl > price ? 'above' : 'below') : 'any')

        // ALREADY TRUE is the dangerous one, and it is why `price` is worth passing in. A guard of
        // "below 305" armed while price is already 300 is satisfied the instant it is written, so it
        // wakes the model, which re-arms it, which wakes the model — a paid loop with no exit.
        //
        // A TOUCH is exempt: `any` needs price to ARRIVE at the level, and sitting near one is not
        // arriving at it.
        if (direction !== 'any' && Number.isFinite(price)) {
            const satisfied = direction === 'above' ? price >= lvl : price <= lvl
            if (satisfied) continue
        }

        if (out.length >= MAX_GUARDS) break
        out.push({ price: lvl, direction, means: GUARD_MEANINGS.includes(g.means) ? g.means : null })
    }
    return out
}

/**
 * Does this guard fire on what price did since the last sweep? Pure.
 *
 * TESTED AGAINST A RANGE, NOT A SPOT PRICE. "Did price cross 312" is a fact about an INTERVAL;
 * asking where price happens to be at the moment of a glance misses a level touched and left
 * between two looks. Given the high/low since the last evaluation an exact level is as catchable
 * as a wide band ever was.
 *
 * @param {object} guard                        one clamped guard
 * @param {?{high:number,low:number}} range     what price did since the last sweep
 */
export function guardFires(guard, range = null) {
    const p = num(guard?.price)
    if (!Number.isFinite(p)) return false
    if (!range || !Number.isFinite(range.high) || !Number.isFinite(range.low)) return false
    return guard.direction === 'below' ? range.low <= p
        // A TOUCH: the range STRADDLES the level, so price was at or through it at some point in the
        // window — including a gap clean over it, which is the case a spot read misses worst.
        : guard.direction === 'any' ? (range.low <= p && range.high >= p)
        : range.high >= p
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

// ─── Legs ─────────────────────────────────────────────────────────────────────
//
// A LEG IS A PRICE. There is no zone, no band and no edge anywhere in this kind (2026-09-24).
//
// WHAT WAS REMOVED, AND WHY IT SURVIVED AS LONG AS IT DID. The document used to carry
// `entry_legs` / `stop_legs` / `target_legs`, each `{lower, upper}`. The band was never a trading
// idea: it was compensation for a monitor that glanced at the SPOT price every half hour, so a level
// could only be caught if price happened to be sitting on it at the moment of a lazy look
// (docs/desks/mentor-talos.md §Guards). The guards build retired that in August 2026 — the sweep
// tests the RANGE since the last look, so an exact price is as catchable as a wide band — and
// Mentor stopped drawing bands the same day. What stayed was the STORAGE: two keys holding one
// number, kept because renaming them meant migrating live armed documents for a cosmetic gain.
//
// It was never only cosmetic. Every consumer had to know which edge a leg acts at, so the edge rule
// (`zoneLevel(zone, isLong, which)`) had to be threaded through sizing, R:R, the resting orders, the
// prompts and the UI — and every one of them was a place the wrong edge could be picked. A stop the
// user put at 306, widened to 305.2–306.4, rested at 305.2: more risk than they agreed to, and
// nothing in the journal said so. Deleting the shape deletes that whole class of bug, and with it
// `zoneLevel`'s `isLong`/`which` arguments, the edge selection in `stopEdge` / `targetEdges` /
// `routeSetupLegs`, and the "far edge" reasoning in four docs.
//
// THE MIGRATION WAS A DELETION. Existing setups were wiped in both databases rather than converted
// (24 documents, 2026-09-24, the user's call) — so nothing here reads the old shape, on purpose. A
// document still carrying `entry_legs` does not half-work; it has no legs at all.

/**
 * Coerce one leg: a PRICE, with a size and, optionally, conditions.
 *
 * `conditions` are the same sentence an entry condition is — a stop or a target may carry its own
 * ("out if it closes below the 4hr VWAP"), same shape, same normaliser, same document-wide id space,
 * judged by the same model read. That is the whole reason there is no condition tree and no separate
 * exit evaluator: a condition is text the model judges, wherever it hangs.
 *
 * `used` threads the document-wide id set through, exactly as it does for scenario conditions —
 * `monitor_state.conditions` is ONE latch map for the setup, so a target's condition sharing an id
 * with a scenario's would let one latch answer for the other.
 */
export function normalizeLeg(z, i, prefix, { used, anchors = null } = {}) {
    if (!z || typeof z !== 'object') return null

    const price = num(z.price)
    if (!Number.isFinite(price)) return null

    const id  = typeof z.id === 'string' && z.id.trim() ? z.id.trim() : `${prefix}${i + 1}`
    const qty = num(z.quantity)
    return {
        id,
        price,
        quantity: Number.isFinite(qty) && qty > 0 ? qty : null,
        note:     typeof z.note === 'string' && z.note.trim() ? z.note.trim() : null,
        // WHAT THIS PRICE IS MEASURED FROM (setup.taxonomy.js). A stop and a target answer to
        // different vocabularies, so the caller passes the one that applies; an ENTRY leg passes
        // none, because the scenario's `archetype` is what an entry is anchored to.
        //
        // It is documentation the user can challenge, never an input to execution: the order rests
        // at `price` whatever the anchor says. `structure` on a stop at 234.8 is what turns "why
        // that stop?" into a citation instead of an argument.
        anchor:   normalizeTaxon(anchors, z.anchor),
        conditions: normalizeConditions(z.conditions, { used, prefix: `${id}c` }),
    }
}

export function normalizeLegs(arr, prefix, { used, anchors = null } = {}) {
    if (!Array.isArray(arr)) return []
    return arr.map((z, i) => normalizeLeg(z, i, prefix, { used, anchors })).filter(Boolean)
}

/**
 * The price a leg stands at — the whole of what `zoneLevel(zone, isLong, which)` used to decide.
 *
 * It keeps its own function rather than becoming `leg.price` at every call site because a leg
 * reaches this from three directions: normalised (always a number), straight off a model reply, and
 * out of a shared blueprint. Returning null for the last two is what keeps an unpriced leg out of a
 * prompt and out of an order, instead of `NaN` reaching a broker.
 */
export function legPrice(leg) {
    const p = num(leg?.price)
    return Number.isFinite(p) ? p : null
}

/**
 * A SCENARIO's size — the sum of its own entry legs, which in v1 is usually exactly one, so this is
 * simply "the position this premise takes".
 *
 * NEVER SUMMED ACROSS SCENARIOS. Scenarios are rivals, not legs: the first to fulfil takes the whole
 * trade and the others die. The predecessor of this function summed every entry leg on the document
 * while the monitor fired ONCE for that total — so two rival entries of 100 placed 200. Scaling in
 * (several entries inside ONE scenario) is what this sum is reserved for.
 */
export function scenarioQuantity(entryLegs) {
    const sum = (entryLegs ?? []).reduce((acc, z) => acc + (Number(z?.quantity) || 0), 0)
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
            // Unstamped → 'judgment'. Claiming 'measured' without the conversation having
            // established a test would overstate how hard the check is.
            mode:        CONDITION_MODES.includes(c.mode) ? c.mode : 'judgment',
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
        // NULL WHEN UNAUTHORED, where `on_break` above defaults. The asymmetry is the feature: the
        // monitor's behaviour without an answer is already safe (a runaway is announced once and
        // never closes anything), so a default here would buy nothing except the silent skipping of
        // the one question this field exists to force — "and if it just goes?". `setupReadiness`
        // blocks on the null, which is how the question gets asked while the plan is being built
        // rather than discovered when price is already gone.
        on_away:   ON_AWAY.includes(raw.on_away) ? raw.on_away : null,
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
 * Leg ids are prefixed with the scenario's id, so they stay unique document-wide and `armed_leg_id`
 * resolves to exactly one leg. An authored id always wins.
 */
export function normalizeScenario(raw, i, { direction = null, used, ids } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    const taken = ids ?? new Set()
    let id = (typeof raw.id === 'string' && raw.id.trim()) ? raw.id.trim() : `s${i + 1}`
    if (taken.has(id)) { let n = 2; while (taken.has(`${id}_${n}`)) n++; id = `${id}_${n}` }
    taken.add(id)

    // `used` rides into the legs too: a target's own condition shares the document-wide latch map
    // with every scenario condition, so its id has to be claimed from the same set.
    const entry_legs  = normalizeLegs(raw.entry_legs,  `${id}e`, { used })
    const stop_legs   = normalizeLegs(raw.stop_legs,   `${id}s`, { used, anchors: STOP_ANCHORS })
    const target_legs = normalizeLegs(raw.target_legs, `${id}t`, { used, anchors: TARGET_ANCHORS })

    const sc = {
        id,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
        // THE WAY IN, named from the closed set. Mentor's filing of its own plan, never a question
        // put to the user — the same rule `trade_mode` follows. It is what makes the rejects pool
        // answerable ("you took the pullback; what about the sweep?") and what the runaway redraw
        // reads to know which continuation to even ask about (`siblingOf`).
        archetype: normalizeTaxon(ENTRY_ARCHETYPES, raw.archetype),
        entry_legs,
        stop_legs,
        target_legs,
        conditions: normalizeConditions(raw.conditions, { used, prefix: `${id}c` }),
        validity:   normalizeValidity(raw.validity),
        quantity:   scenarioQuantity(entry_legs),
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
 * THE ONE PLACE THAT KNOWS THE FLAT SHAPE. A plan given as root-level legs and validity — no
 * `scenarios` — becomes a single implicit scenario, so every other module reads scenarios and
 * nothing else.
 *
 * It used to carry "delete this when no pre-scenario documents remain", and those are gone (every
 * setup was wiped with the zone shape, 2026-09-24). It stays anyway, for the job it turned out to
 * be doing: the flat legs ARE the execution projection (`projectScenario`), and `PLAN_FIELDS`
 * writes them alongside `scenarios` on every edit. A normaliser that could not read its own output
 * back would make the projection a one-way door.
 *
 * `scenarios` wins whenever it is present, so this only ever fires on a plan that has no premise
 * structure at all.
 */
function _scenarioSource(raw) {
    if (Array.isArray(raw?.scenarios) && raw.scenarios.length) return raw.scenarios
    const flat = raw?.entry_legs ?? raw?.stop_legs ?? raw?.target_legs ?? raw?.validity
    if (!flat) return []
    return [{
        id: 's1',
        name: null,
        entry_legs:  raw.entry_legs,
        stop_legs:   raw.stop_legs,
        target_legs: raw.target_legs,
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
 * `entry_legs` / `stop_legs` / `target_legs` / `quantity` are NOT setup-private: every kind-blind
 * consumer reads them flat — protectionPlan's `routeSetupLegs`, the order plan, the watch row. So
 * scenarios stay the authored and monitored model, and the winning scenario is stamped down here
 * when it arms. Execution never learns that scenarios exist.
 *
 * Pre-arm the projection is the FIRST scenario — the primary, which Mentor authors first. The row
 * shows every scenario (toWatchRow) so a second premise is never hidden behind this one. Pure.
 */
export function projectScenario(setup, id = null) {
    const sc = pickScenario(setup, id)
    return {
        entry_legs:  sc?.entry_legs  ?? [],
        stop_legs:   sc?.stop_legs   ?? [],
        target_legs: sc?.target_legs ?? [],
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

// ─── alternatives[] — the ways in that were REJECTED ──────────────────────────
//
// The pool a scenario is promoted out of, and the only record the app keeps of the road not taken
// (docs/design/mentor-challenge.md §1). "Is there a better way into this?" is unanswerable as an
// open search and finite against the closed set in setup.taxonomy.js, so the plan carries the
// members it did NOT take, one clause each.
//
// PROVENANCE, NEVER AN INSTRUCTION. Nothing in monitoring/ may read this: a rejected way in is not
// a condition, and feeding the rejects to an assess prompt would have Talos weighing premises the
// user explicitly did not take. It is also a SNAPSHOT — the reason a gap fill was skipped stops
// being true the day the gap fills, which is what a journal entry is and not a bug to fix.
//
// It does not travel in a blueprint (setup.blueprint.js): a fork gets the plan, and the author's
// reasoning about what they didn't take stays with the author.

/**
 * Coerce the rejects pool. Capped, clause-length bounded, and every entry needs BOTH an archetype
 * from the set and a reason.
 *
 * A reject with no reason is dropped on purpose, and it is the one strict rule here. The entry's
 * entire value is the answer to "why not that one?" — so an archetype on its own is a hollow claim
 * that a coverage check could not tell from a real one, and five of them would satisfy any
 * emptiness test while recording nothing. Pure.
 */
export function normalizeAlternatives(arr) {
    if (!Array.isArray(arr)) return []
    const out = []
    for (const a of arr) {
        if (!a || typeof a !== 'object' || Array.isArray(a)) continue
        const archetype = normalizeTaxon(ENTRY_ARCHETYPES, a.archetype)
        const why       = typeof a.why_not === 'string' ? a.why_not.trim().slice(0, MAX_WHY_NOT) : ''
        if (!archetype || !why) continue
        const price = num(a.price)
        out.push({ archetype, price: Number.isFinite(price) ? price : null, why_not: why })
        if (out.length >= MAX_ALTERNATIVES) break
    }
    return out
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
 * Server-derived fields (`quantity`, the execution projection) are always recomputed here, so an
 * attempt by the model to author them is overwritten rather than trusted. `pace_rungs` is NOT one
 * of them — which chart a plan is read on is the plan's own decision, so it is normalised from the
 * model's own field like any other authored value, and only falls back to the ladder when nothing
 * was named.
 */
export function normalizeSetup(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    const type      = TRADE_HORIZONS.includes(raw.type) ? raw.type : null
    const timeframe = VALID_TIMEFRAMES.has(normalizeTimeframe(raw.timeframe)) ? normalizeTimeframe(raw.timeframe) : null
    const direction = raw.direction === 'short' ? 'short' : raw.direction === 'long' ? 'long' : null
    const marketCap = MARKET_CAPS.includes(raw.market_cap) ? raw.market_cap : null

    // THE TWO SOURCES, resolved here because this is the only place that holds both the named rungs
    // and the horizon+cap the ladder needs. Named wins outright and is never added to.
    const named     = normalizePaceRungs(raw.pace_rungs)
    const paced     = named.length ? named : ladderFor(type, marketCap, timeframe)

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
        trade_mode:  TRADE_MODES.includes(raw.trade_mode) ? raw.trade_mode : 'discretionary',
        // The PREMISE rung — the chart the plan was drawn on. Context for every read, and the
        // default for a validity range that names none. It does NOT set the pace.
        timeframe,
        // The rungs Talos is READ on. Never empty: what the user named, else the horizon's ladder.
        pace_rungs:  paced,
        // Bucketed once at Generate and never re-fetched — a setup's ladder must not move under it
        // because the stock had a good quarter.
        market_cap:  marketCap,
        // Which TIER runs each candle. `read_mode`, not `mode`: a setup's `mode` is already the
        // WORKSPACE (live | paper | manual), bound at Generate, and two meanings on one key is the
        // trap the condition `mode` rename was written to avoid.
        read_mode:   READ_MODES.includes(raw.read_mode) ? raw.read_mode : defaultReadMode({ conditions, scenarios }),
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

        // The ways in that were considered and NOT taken. Authored once at the scenario rung and
        // carried forward unchanged, like a condition id — a pool that gets re-derived every turn is
        // a prompt bug, not a reason to drop the field. Empty is the correct answer on a plan the
        // user brought: they chose the way in, and filling this with what they could have done
        // instead would be re-opening their plan by the back door.
        alternatives: normalizeAlternatives(raw.alternatives),

        conviction: cleanConviction(raw.conviction) || null,

        // The model sets this when the only entry trigger is price arriving at a specific level —
        // no candle close, no indicator, no pattern. Talos skips the assessment and fires the
        // confirm card on the first armed wake. Everything else is 'conditional' (the default).
        entry_mode: raw.entry_mode === 'limit' ? 'limit' : 'conditional',

        // Server-derived — recomputed every time, never taken from the model. `entry_legs`,
        // `stop_legs`, `target_legs`, `validity`, `quantity` and `rr` are the EXECUTION PROJECTION of
        // one scenario (projectScenario): pre-arm the first, and re-stamped by Talos to the armed
        // one when a zone trips. Authoring them directly does nothing — scenarios are the source.
        ...projectScenario({ scenarios }, raw.armed_scenario_id ?? null),
    }
}

/**
 * What a DISARMED setup looks like: back to `waiting`, with every trace of the entry that was armed
 * for it cleared. Pure — the caller cancels at the broker and persists in its own way.
 *
 * THREE CALLERS, ONE FIELD LIST, and that is the whole reason this is a function. Talos disarms on
 * expiry or a validity breach; the user disarms explicitly; and leaving `hit` through a plain status
 * patch is the same event under a third name. Each had its own literal, and a field added to one —
 * `armed_scenario_id` was, when rivals arrived — is a field the other two go on leaving behind, so
 * the setup re-arms carrying a dead premise's id.
 *
 * `waiting`, never `looking`: re-arming is the user's own act, exactly as it is after a re-draw. A
 * setup that disarmed itself on expiry and then silently went back to watching would be the one
 * behaviour nobody asked for.
 */
export function disarmedSetupPatch() {
    return {
        status:            'waiting',
        orderState:        null,
        pendingOrder:      null,
        brokerOrders:      null,
        entryTriggeredAt:  null,
        ordersPlacedAt:    null,
        armed_leg_id:     null,
        armed_scenario_id: null,
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
    const missing  = []
    const warnings = []
    if (!setup?.asset)      missing.push('asset')
    if (!setup?.direction)  missing.push('direction')
    if (!setup?.type)       missing.push('horizon')

    const list  = setup?.scenarios ?? []
    const multi = list.length > 1
    const root  = setup?.conditions ?? []

    if (!list.length) missing.push('scenario')

    for (const sc of list) {
        // With two premises in play, "missing stop price" is ambiguous — say WHICH one.
        const at = (what) => (multi ? `${what} on ${scenarioLabel(sc)}` : what)

        if (!(sc.entry_legs?.length)) missing.push(at('entry price'))
        // Scaling in is supported: execution places the ARMED LEG's size (legQuantity), the monitor
        // watches the rest (pendingLegs) and the resting stop grows to cover each new leg. What the
        // block used to guarantee still has to hold, so it becomes a narrower rule: with more than
        // one leg EVERY leg must carry its own size, because a leg with none falls back to the
        // premise total and would place the whole position on the first print — the exact failure
        // the old block existed to prevent.
        else if (sc.entry_legs.length > 1 && sc.entry_legs.some(z => !(Number(z?.quantity) > 0))) {
            missing.push(at('a size on every entry leg (scaling in places each leg separately)'))
        }

        if (!(sc.stop_legs?.length)) missing.push(at('stop price'))

        // A TARGET IS REQUIRED. A premise without one is a position that can only ever be closed by
        // its stop, by hand, or by Talos noticing. "Where does this pay?" is half of the plan; a
        // setup that cannot answer it is not finished being authored.
        //
        // Checked through targetLevels rather than on `target_legs.length`, because a leg is only a
        // leg by the array's reckoning until a real number reaches the order book.
        if (!targetLevels(scenarioView(setup, sc)).length) missing.push(at('target price'))

        if (!Number.isFinite(sc.quantity) || sc.quantity <= 0) missing.push(at('quantity'))

        // PRESENCE only, counting the root tier. Whether a condition is *checkable* is Mentor's gate
        // and lives in the prompt — code can't read a sentence and say how anyone would know. But a
        // scenario with nothing to check arms blind: Talos falls through to `judge on price structure
        // at the level alone` and the premise never gets tested. A scenario needs no trigger of its
        // own when the root carries one.
        // limit setups intentionally carry zero conditions — the price touch IS the trigger.
        if (setup.entry_mode !== 'limit' && !root.length && !(sc.conditions?.length)) missing.push(at('condition'))

        // "AND IF IT JUST GOES?" — the question a missed trade makes urgent and nobody asks while
        // the plan is being built. The away edge is the one edge with no authored intent behind it
        // (docs/design/mentor-challenge.md §3), so a range that can report a runaway must say what
        // to do about one: ping for a redraw, or let it go.
        //
        // Gated on the RANGE existing, not on the entry needing price to come back. The narrower
        // test — is this entry below the live price? — needs a quote, and readiness is pure and must
        // stay that way; asking the question in the shape the archetype deserves is the prompt's
        // job. A scenario with no validity range has no away edge to answer for.
        //
        // Kept to two plain words because this string becomes an API reason slug
        // (`validateSetup` → `missing_runaway_answer`), exactly as 'stop price' does. Punctuation and
        // parentheses in a `missing` entry travel into a refusal code that a client has to match on.
        if (sc.validity && !sc.validity.on_away) missing.push(at('runaway answer'))
    }
    if (!list.length && !root.length) missing.push('condition')

    if (!hasAccount) missing.push('trading account')

    // SOFT — never blocks. Coverage strength 2 of docs/design/mentor-challenge.md §1: the gate can
    // see that nothing was rejected, and cannot see whether anything SHOULD have been. It is
    // correct-and-noisy on a plan the user brought, where an empty pool is the right answer; until
    // something marks which path authored the plan, that false positive is the price of the signal.
    if (!(setup?.alternatives?.length)) warnings.push('no rejected ways in recorded')

    const problems = validityProblems(setup)
    return { ready: missing.length === 0 && problems.length === 0, missing, problems, warnings }
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
    return list.flatMap(sc => {
        const view = scenarioView(setup, sc)
        // `windowProblems` used to ride here, policing a TP band's breadth. There are no bands to
        // police: a target is the price the user named, and the "room to talk in" it used to
        // measure is now a guard the monitor arms (docs/desks/mentor-talos.md).
        return rangeProblems(view)
            .map(p => (multi ? `${scenarioLabel(sc)}: ${p}` : p))
    })
}

/**
 * The coherence check for ONE plan — a scenario, or anything else carrying `direction` + `validity`
 * + `stop_legs`. Per scenario because the range and the stop it must outlive both belong to the
 * same premise: checking the false break's floor against the breakout's stop compares two different
 * trades. Pure.
 */
export function rangeProblems(setup) {
    const out  = []
    const long = setup?.direction === 'long'

    // An entry BEYOND the stop can never fill — price arriving there means the stop already went, so
    // the leg is unreachable by construction. Harmless-looking on one leg and actively misleading on
    // several: a scale-in ladder drawn through its own stop reads like a plan to add twice and can
    // only ever add once.
    //
    // Checked before the validity guard below, because it has nothing to do with validity: a setup
    // with no range at all can still be drawn this way. (Found while writing scale-in fixtures — a
    // second leg placed under the stop made every gate report `adverse`, correctly.)
    //
    // The INVERTED-zone guard that used to skip this check went with the bands: there are no edges
    // left to be in the wrong order, so a leg is either priced or it is not a leg.
    const working = stopEdge(setup)
    if (working != null) {
        const unreachable = (setup?.entry_legs ?? [])
            .map(legPrice)
            .filter(Number.isFinite)
            .filter(e => (long ? e <= working : e >= working))
        if (unreachable.length) out.push('an entry sits past the stop, where price could never reach it')
    }

    const v = setup?.validity
    if (!v) return out

    // The furthest stop = the most risk the plan admits. Beyond it the trade is dead by its own
    // terms, so the validity floor/ceiling must not sit further out than that.
    const stops = (setup?.stop_legs ?? []).map(legPrice).filter(Number.isFinite)
    if (stops.length) {
        const stopFar = long ? Math.min(...stops) : Math.max(...stops)
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
 * The size of ONE entry leg — the armed leg's own quantity, or null when it carries none. Pure.
 *
 * Execution projects a scenario's whole size onto the flat `quantity` field (projectScenario), which
 * is right while a premise has one leg and wrong the moment it has two: the first leg to print
 * would place the size of BOTH, so the position would be fully on with only half the plan
 * confirmed. That is the readiness block's reasoning, and this is what has to exist before it can
 * be lifted.
 *
 * A no-op on a single-leg premise, where `scenarioQuantity` IS that leg's quantity, so the leg and
 * the scenario agree and nothing changes.
 */
export function legQuantity(scenario, legId) {
    const leg = (scenario?.entry_legs ?? []).find(z => z?.id === legId)
    const q   = Number(leg?.quantity)
    return Number.isFinite(q) && q > 0 ? q : null
}

/**
 * The armed premise's entry legs that have NOT filled yet — the legs still to scale into. Pure.
 *
 * Keyed on the leg ids already recorded in `entry.legs[]`, not on a count, because legs can fill
 * out of order: a premise with a dip leg and a reclaim leg fills whichever prints first.
 *
 * Empty for a single-leg premise the moment it fills, which is what keeps the scale-in path inert
 * for an ordinary one-entry setup.
 */
export function pendingLegs(scenario, entry) {
    const filled = new Set((entry?.legs ?? []).map(l => l?.leg_id).filter(Boolean))
    return (scenario?.entry_legs ?? []).filter(z => z?.id && !filled.has(z.id))
}

/**
 * Which entry leg an `enter` verdict fires on. The one price is AT when the wake resolved to a
 * specific level, else the scenario's first unfilled leg.
 *
 * WHY THE FALLBACK EXISTS. Until 2026-09-23 an `enter` could only fire when `hit` was non-null,
 * and `hit` came from a containment test against what was already a zero-width price — so it matched
 * a live quote only by coincidence. In prod, 18 of 18 entry levels were points and only 2 of 70
 * journal rows carried one at all: entries worked solely because the model happened to arm its
 * guards at the exact authored price. The shape that broke it is the commonest one there is —
 * price arrives, conditions confirm two candles later, and by then `clampGuards` has dropped the
 * already-satisfied entry guard and `woke_on` is long cleared, leaving no path to `enter`.
 *
 * So the level stopped being a second opinion on a decision the read already made. The leg keeps
 * its three real jobs — the order price, the size, the r:r — and the verdict decides. Pure.
 */
export function firingLeg(scenario, leg = null) {
    if (leg?.id) return leg
    return pendingLegs(scenario, null)[0] ?? null
}

/**
 * The legs of ONE scenario that Talos reads — every leg that carries a condition in words
 * (docs/design/talos-per-candle.md). Pure.
 *
 * THE ONE PREDICATE for "does this position earn a model call", and the one source of the verdict
 * menu (`allowedVerdicts`). A plain stop or target is an order resting at the broker and nobody
 * reads it. Only a sentence somebody has to judge costs a read — and that is exactly what the user
 * opted into when they attached one.
 *
 * `entries` are the pending legs (not yet filled). A pending leg is judged by the setup's ENTRY
 * conditions (root ∪ scenario — the same mandate the first leg was taken on) plus any of its own,
 * so on a conditional setup every pending leg is watched; only a `limit` setup, which declares no
 * conditions at all, has nothing to read there.
 *
 * @returns {{ stop: ?object, targets: object[], entries: object[] }}
 */
export function watchedLegs(setup, scenario, entry = null) {
    const has     = (z) => Array.isArray(z?.conditions) && z.conditions.length > 0
    const judged  = setup?.entry_mode !== 'limit' && declaredConditions(setup, scenario).length > 0
    return {
        stop:    (scenario?.stop_legs ?? []).find(has) ?? null,
        targets: (scenario?.target_legs ?? []).filter(has),
        entries: pendingLegs(scenario, entry).filter(z => judged || has(z)),
    }
}

export function hasWatchedLegs(w) {
    return !!(w?.stop || w?.targets?.length || w?.entries?.length)
}

/**
 * What an in-position read may decide, given which legs are watched. `hold` always; the rest only
 * where the user wrote a condition that makes the question theirs. Pure.
 *
 * Derived rather than fixed so the prompt never offers a verdict the monitor would refuse, and the
 * monitor never has to refuse one the prompt offered.
 */
export function allowedVerdicts(w) {
    const out = ['hold']
    if (w?.stop)            out.push('move_stop', 'exit_now')
    if (w?.targets?.length) out.push('take_partial')
    if (w?.entries?.length) out.push('add_leg')
    return out
}

/**
 * One entry LEG, folded into the running position. Pure.
 *
 * Scaling in means a position is built from several fills at different prices, so `entry` stops
 * being a single fact and becomes an aggregate: `legs[]` is what actually happened, `size` their
 * sum, and `fill_price` their SIZE-WEIGHTED average.
 *
 * The average is the load-bearing part. `rMultiple` measures from `entry.fill_price`, and it feeds
 * `computeMetrics`' R / mae / mfe — what every in-position read and the UI are handed — so a plain
 * mean of the leg prices, or simply keeping the first fill, would misreport R on every read of
 * every scaled position. Weight by size or the number is fiction.
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
 * The working stop: the FURTHEST stop, i.e. the most risk the plan admits. Null when none is
 * authored. Pure.
 *
 * Selected by price, never by array position — the model emits legs in whatever order it reasoned
 * about them, so `stop_legs[0]` is not the far one.
 */
export function stopEdge(setup) {
    const isLong = setup?.direction === 'long'
    const stops  = (setup?.stop_legs ?? []).map(legPrice).filter(Number.isFinite)
    if (!stops.length) return null
    return isLong ? Math.min(...stops) : Math.max(...stops)
}

/**
 * Targets NEAREST-FIRST — ordered by price, never by array position. Trusting `target_legs[0]` would
 * quietly hand a multi-target setup the rr of its furthest leg. Empty when none. Pure.
 *
 * This and `targetLevels` used to be allowed to disagree — this one read a tp band's NEAR edge (the
 * pessimistic reward) while `targetLevels` read where the limit rested (the far edge), because an
 * R:R must never flatter. With bands gone they read one number, and the asymmetry is kept only as
 * the ORDER rule below: r:r is measured to the nearest.
 */
export function targetEdges(setup) {
    const isLong = setup?.direction === 'long'
    const prices = (setup?.target_legs ?? []).map(legPrice).filter(Number.isFinite)
    return prices.sort((a, b) => (isLong ? a - b : b - a))
}

/**
 * Targets NEAREST-FIRST, each as `{ target, quantity, conditions }` — the shape the position carries and the
 * order a partial ladder fires in. Pure.
 *
 * REPLACES `targetWindows`, which read a tp zone as a window: `target` at the far edge and `wake` at
 * the near one, the level where Talos was allowed to start proposing. Under
 * docs/desks/mentor-talos.md there is no window — a target is the price the user named, and the
 * room to talk in is a GUARD the monitor arms and rewrites, not breadth Mentor drew once.
 *
 * `conditions` rides along because a target may carry its own ("bank half if momentum stalls"). It
 * is the same sentence an entry condition is, judged by the same read; a target with none is a plain
 * limit resting at the broker that wakes nothing at all.
 */
export function targetLevels(setup) {
    const isLong = setup?.direction === 'long'
    return (setup?.target_legs ?? [])
        .map(z => ({ target: legPrice(z), quantity: z?.quantity ?? null, conditions: z?.conditions ?? [] }))
        .filter(t => Number.isFinite(t.target))
        .sort((a, b) => (isLong ? a.target - b.target : b.target - a.target))
}

/**
 * Reward-to-risk from the PESSIMISTIC fill, per docs/desks/mentor-talos.md
 *
 * SCOPED TO ONE PLAN — a scenario (via scenarioView), or the projected document, both of which carry
 * `direction` + the three leg arrays. Pricing a setup's r:r across scenarios would run one
 * premise's entry to another's target and describe a trade nobody planned.
 *
 * The pessimism that survives the bands: risk runs to the FURTHEST stop (the failsafe rests at the
 * far side) and reward to the NEAREST target — what the trade pays if the first target is the one
 * that gets taken. The entry's own "worst edge" term is gone with the edges: an entry is the one
 * price the user named, so there is no longer a favourable side of it to decline.
 *
 * Legs are SELECTED by price, never by array position: the model emits legs in whatever order it
 * reasoned about them, so trusting `target_legs[0]` to be the first target would quietly hand a
 * multi-target setup the rr of its furthest leg.
 *
 * `entryPrice` overrides the plan's entry — that's the LIVE rr at the confirm card, computed from
 * the actual price rather than the plan.
 *
 * Returns null when any leg is missing or risk is zero (an entry inside its own stop).
 */
export function computeRR(setup, entryPrice = null) {
    const isLong = setup?.direction === 'long'
    const first  = setup?.entry_legs?.[0]
    if (!first) return null

    const entry   = Number.isFinite(entryPrice) ? entryPrice : legPrice(first)
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
