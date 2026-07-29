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
export const WATCH_KINDS  = ['price_action', 'structure', 'correlation', 'market', 'news', 'positioning', 'fundamental']
export const WATCH_WEIGHTS = ['primary', 'confirming']

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

// ─── watch[] ──────────────────────────────────────────────────────────────────

/**
 * Coerce the monitor's instruction sheet. An unknown `kind` is DROPPED rather than defaulted —
 * a bogus kind would silently mount the wrong tools (or none), and a factor the monitor can't
 * act on is worse than an absent one. A factor with no `look_for` is equally useless: the
 * assessment has nothing to verify against, so it goes too.
 */
export function normalizeWatch(arr) {
    if (!Array.isArray(arr)) return []
    return arr.reduce((out, w) => {
        if (!w || typeof w !== 'object') return out
        if (!WATCH_KINDS.includes(w.kind)) return out

        const lookFor = typeof w.look_for === 'string' ? w.look_for.trim() : ''
        if (!lookFor) return out

        const symbols = Array.isArray(w.symbols)
            ? [...new Set(w.symbols.filter(s => typeof s === 'string' && s.trim()).map(s => s.toUpperCase().trim()))]
            : []

        out.push({
            kind:      w.kind,
            look_for:  lookFor,
            weight:    WATCH_WEIGHTS.includes(w.weight) ? w.weight : 'confirming',
            timeframe: normalizeTimeframe(w.timeframe) || null,
            ...(symbols.length ? { symbols } : {}),
        })
        return out
    }, [])
}

/**
 * The distinct tool groups a watch list activates — what the monitor will actually fetch.
 * Exposed so the cost of a setup is inspectable before it's saved (and so Talos builds its
 * tool set from the same source the UI explains it from).
 */
export function watchKinds(watch) {
    return [...new Set((watch ?? []).map(w => w.kind))]
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

        thesis: typeof raw.thesis === 'string' ? raw.thesis.trim() : '',
        watch:  normalizeWatch(raw.watch),

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
    if (!hasAccount)        missing.push('trading account')
    return { ready: missing.length === 0, missing }
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
