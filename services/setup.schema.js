// The `setup` entity contract — normalisation + readiness, in ONE place.
//
// Mentor authors a setup as free-ish JSON; Talos monitors it as a strict shape. This module is
// the seam: it coerces whatever the model emitted into the documented payload (docs/setup-entity.md
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
// tools, so an enum here would only ever narrow what can be checked (docs/mentor-talos-refactor.md
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

    let lo = Number(z.lower)
    let hi = Number(z.upper)

    // Point emitted instead of a band → zero-width zone at that price.
    if (!Number.isFinite(lo) && !Number.isFinite(hi)) {
        const p = Number(z.price)
        if (!Number.isFinite(p)) return null
        lo = hi = p
    } else if (!Number.isFinite(lo)) lo = hi
    else if (!Number.isFinite(hi)) hi = lo

    if (lo > hi) [lo, hi] = [hi, lo]

    const qty = Number(z.quantity)
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

/** Total authored size = the sum of entry-zone quantities (scale-in legs sum to the position). */
export function totalQuantity(entryZones) {
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
export function normalizeConditions(arr) {
    if (!Array.isArray(arr)) return []
    const used = new Set()

    const claim = (wanted, i) => {
        let id = wanted || `c${i + 1}`
        if (used.has(id)) {
            let n = 2
            while (used.has(`${id}_${n}`)) n++
            id = `${id}_${n}`
        }
        used.add(id)
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

    let lower = Number(raw.lower)
    let upper = Number(raw.upper)
    if (!Number.isFinite(lower)) lower = null
    if (!Number.isFinite(upper)) upper = null
    if (lower == null && upper == null) return null
    if (lower != null && upper != null && lower > upper) [lower, upper] = [upper, lower]

    const approach = Number(raw.approach)
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

    const entry_zones = normalizeZones(raw.entry_zones, 'ez')
    const stop_zones  = normalizeZones(raw.stop_zones,  'sz')
    const tp_zones    = normalizeZones(raw.tp_zones,    'tp')

    const rr = Number(raw.rr)

    return {
        asset:       typeof raw.asset === 'string' ? raw.asset.toUpperCase().trim() : '',
        // Canonicalised at the door: market hours, event risk and the monitors all branch on
        // this, and each had grown its own synonym map. An unknown value becomes null, which
        // every consumer already reads as "fall back to the symbol heuristic".
        asset_class: normalizeAssetClass(raw.asset_class),
        direction:   raw.direction === 'short' ? 'short' : raw.direction === 'long' ? 'long' : null,
        type,
        trade_mode:  TRADE_MODES.includes(raw.trade_mode) ? raw.trade_mode : 'classical',
        timeframe,
        active_from: isoOrNull(raw.active_from),
        valid_until: isoOrNull(raw.valid_until),

        thesis:     typeof raw.thesis === 'string' ? raw.thesis.trim() : '',
        conditions: normalizeConditions(raw.conditions),
        validity:   normalizeValidity(raw.validity),
        // The symbols a condition may pull the monitor onto, beyond the setup's own asset. Free
        // text can name anything; the fetch budget stays bounded by what Mentor extracted at build.
        referenced_symbols: normalizeSymbols(raw.referenced_symbols),

        entry_zones,
        stop_zones,
        tp_zones,

        conviction: cleanConviction(raw.conviction) || null,
        rr:         Number.isFinite(rr) ? rr : null,

        // Server-derived — recomputed every time, never taken from the model.
        quantity: totalQuantity(entry_zones),
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
    if (!(setup?.entry_zones?.length))               missing.push('entry zone')
    if (!(setup?.stop_zones?.length))                missing.push('stop zone')
    if (!Number.isFinite(setup?.quantity) || setup.quantity <= 0) missing.push('quantity')
    // PRESENCE only. Whether a condition is *checkable* is Mentor's gate and lives in the prompt —
    // code can't read a sentence and say how anyone would know. But zero conditions is the one part
    // it can see, and it means the setup arms with nothing to verify against its thesis: Talos falls
    // through to `judge on price structure at the zone alone` and the premise never gets tested.
    if (!(setup?.conditions?.length))                missing.push('condition')
    if (!hasAccount)        missing.push('trading account')

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
 * Reward-to-risk from the PESSIMISTIC fill, per docs/setup-entity.md §6.
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
export function computeRR(setup, entryPrice = null) {
    const isLong = setup?.direction === 'long'
    const entryZone = setup?.entry_zones?.[0]
    if (!entryZone || !setup?.stop_zones?.length || !setup?.tp_zones?.length) return null

    const entry = Number.isFinite(entryPrice) ? entryPrice : (isLong ? entryZone.upper : entryZone.lower)
    // Widest stop = most risk; nearest target = least reward.
    const stopEdges = setup.stop_zones.map(z => (isLong ? z.lower : z.upper)).filter(Number.isFinite)
    const tpEdges   = setup.tp_zones.map(z => (isLong ? z.lower : z.upper)).filter(Number.isFinite)
    if (!stopEdges.length || !tpEdges.length) return null

    const stop = isLong ? Math.min(...stopEdges) : Math.max(...stopEdges)
    const tp   = isLong ? Math.min(...tpEdges)   : Math.max(...tpEdges)
    if (!Number.isFinite(entry)) return null

    const risk   = isLong ? entry - stop : stop - entry
    const reward = isLong ? tp - entry   : entry - tp
    if (!(risk > 0)) return null

    return Math.round((reward / risk) * 100) / 100
}
