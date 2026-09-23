// The LADDER — which rungs Talos is read on when nobody named any.
//
// A setup's `pace_rungs` has exactly two sources (docs/design/talos-two-tier.md §Phase 1):
//
//   the user named rungs  →  exactly those, absolutely, and nothing here runs
//   nobody named any      →  ladderFor(horizon, marketCap)
//
// So this module is the DEFAULT and never an override. A named rung is the user forcing their own
// approach; Mentor may argue with it in the conversation and must then file it verbatim.
//
// WHY MARKET CAP AND NOT JUST HORIZON. Horizon alone hands a mega cap and a microcap the same
// rungs, and their noise floors are nothing alike: a 15-minute candle on a $2T name is a readable
// piece of structure, and on a $200M name it is two prints and a spread. The table gets coarser as
// the cap falls for exactly that reason, and finer as it rises.
//
// Pure — no IO, no model calls, no clock.

import { normalizeTimeframe } from './timeframe.service.js'

// ─── The rung vocabulary ──────────────────────────────────────────────────────
//
// It lives here rather than in setup.schema because a rung is what THIS module is about, and
// because the dependency has to run one way: the schema consumes rung facts, the ladder owns them.
// setup.schema re-exports TF_RUNGS and isFetchableRung so its own importers are undisturbed.

/** Coarse → fine. Every rung the app speaks, and the order every rung list is kept in. */
export const TF_RUNGS = ['month', 'week', 'day', '4hr', '2hr', '1hr', '30min', '15min', '5min', '1min']

// The finest rung we can actually GET. `1min` is off-plan at FMP (402) — the rest of the intraday
// tier is fine — so offering it hands the monitor a rung whose fetch can only fail, and the read
// silently degrades to "no candles" at the one end it looks at first.
//
// A DATA-AVAILABILITY floor, deliberately not a vocabulary change: `1min` stays in TF_RUNGS (the
// legacy `idea` kind still speaks it, and it is what a 1-minute condition parses to), so lifting
// this when the plan allows is one line here. It is also no real loss as a SETUP rung — a setup
// judged off a 1-minute chart is reading noise, not structure.
const FINEST_RUNG = '5min'

/** Is this rung one the providers can actually serve? Pure. */
export function isFetchableRung(tf) {
    const i = TF_RUNGS.indexOf(normalizeTimeframe(tf))
    return i !== -1 && i <= TF_RUNGS.indexOf(FINEST_RUNG)
}

/**
 * A rung's length in minutes — how long the model is asking to wait when it asks to look at that
 * rung next. Unknown/absent → null, so a caller can fall back rather than invent a cadence.
 */
export function rungMinutes(tf) {
    return RUNG_MINUTES[normalizeTimeframe(tf)] ?? null
}
const RUNG_MINUTES = {
    month: 30 * 1440, week: 7 * 1440, day: 1440,
    '4hr': 240, '2hr': 120, '1hr': 60, '30min': 30, '15min': 15, '5min': 5, '1min': 1,
}

// ─── Market cap ───────────────────────────────────────────────────────────────

/** Biggest → smallest. */
export const MARKET_CAPS = ['mega', 'large', 'mid', 'small', 'micro']

/** Below this, a bucket is a guess; absent market cap is not an error, it is `null`. */
const CAP_FLOORS = [
    ['mega',  200e9],
    ['large',  10e9],
    ['mid',     2e9],
    ['small', 300e6],
    ['micro',     0],
]

/**
 * Bucket a market cap in USD. Anything unusable → null, which `ladderFor` reads as "assume the
 * middle" rather than as an error: a setup does not fail to be authored because a profile fetch
 * came back empty. Pure.
 */
export function bucketForMarketCap(usd) {
    const n = Number(usd)
    if (!Number.isFinite(n) || n <= 0) return null
    for (const [bucket, floor] of CAP_FLOORS) if (n >= floor) return bucket
    return 'micro'
}

/**
 * Every rung from `a` to `b` INCLUSIVE, coarse→fine, fetchable only. Order-agnostic — `('15min',
 * '1hr')` and `('1hr', '15min')` are the same request.
 *
 * This is also what a trader means out loud. *"15min to 1hr"* is three rungs, not two, and Mentor
 * files the expansion (docs/design/talos-two-tier.md §Phase 7) — filing the two endpoints would
 * silently drop the 30min from someone who asked for the band.
 *
 * Unknown endpoints → []. Pure.
 */
export function rungsBetween(a, b) {
    const i = TF_RUNGS.indexOf(normalizeTimeframe(a))
    const j = TF_RUNGS.indexOf(normalizeTimeframe(b))
    if (i === -1 || j === -1) return []
    return TF_RUNGS.slice(Math.min(i, j), Math.max(i, j) + 1).filter(isFetchableRung)
}

// The table, as ENDPOINTS rather than lists — a ladder is always a contiguous band, and writing the
// band is both shorter and impossible to get internally inconsistent.
//
// Read a row as "how much noise can this horizon afford to look at". The floor rises as the cap
// falls; the ceiling rises as the horizon lengthens.
const LADDER = {
    intraday:    { mega: ['5min', '1hr'],  large: ['5min', '1hr'],  mid: ['15min', '1hr'], small: ['30min', '2hr'], micro: ['30min', '2hr'] },
    day:         { mega: ['15min', '4hr'], large: ['15min', '4hr'], mid: ['30min', '4hr'], small: ['1hr', '4hr'],   micro: ['1hr', '4hr'] },
    swing:       { mega: ['1hr', 'day'],   large: ['1hr', 'day'],   mid: ['2hr', 'day'],   small: ['4hr', 'day'],   micro: ['4hr', 'day'] },
    'long term': { mega: ['day', 'week'],  large: ['day', 'week'],  mid: ['day', 'week'],  small: ['day', 'week'],  micro: ['day', 'week'] },
}

/** Where an unknown cap lands. The middle, because being wrong toward noise is worse than dull. */
const DEFAULT_CAP = 'mid'
/** Where an unknown horizon lands. Day is the shape most plans turn out to be. */
const DEFAULT_HORIZON = 'day'

/**
 * The rungs Talos is read on when nobody named any, coarse→fine. Never empty.
 *
 * THE BAND ALWAYS REACHES THE PREMISE. A plan drawn on the 1hr whose horizon's default band stops
 * at the 2hr would be a plan that is never read on the chart it was drawn on — the ladder is a
 * default for people who did not choose, not a reason to overrule the one rung they did name.
 * Widening keeps it contiguous, because a ladder is always a band.
 *
 * @param {string} horizon    a TRADE_HORIZONS value; unknown/absent → `day`
 * @param {string} marketCap  a MARKET_CAPS value; unknown/absent → `mid`
 * @param {string} [premise]  the setup's own `timeframe`, if it has one
 */
export function ladderFor(horizon, marketCap, premise = null) {
    const row  = LADDER[horizon] ?? LADDER[DEFAULT_HORIZON]
    const cell = row[marketCap] ?? row[DEFAULT_CAP]

    const p = normalizeTimeframe(premise)
    if (!isFetchableRung(p)) return rungsBetween(cell[0], cell[1])

    const band = [TF_RUNGS.indexOf(cell[0]), TF_RUNGS.indexOf(cell[1]), TF_RUNGS.indexOf(p)]
    return rungsBetween(TF_RUNGS[Math.min(...band)], TF_RUNGS[Math.max(...band)])
}
