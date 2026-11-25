// WHEN AN EFFECT IS ACTIVE (docs/design/situation-network-horizons.md §3).
//
// An effect starts some time after its branch HAPPENS (`starts`) and lasts some time (`lasts`). The branch happens on the
// day its question resolved; while it is live, on its resolve-by date (the run's date when that has passed, or there is
// none). The labels are the mapping's; the days are ours. An effect mapped before 2026-11-25 has neither: `now` +
// `quarters`.

import { STARTS, LASTS, realDate } from './model.js'
import { MACRO, layerOf } from './sectors.js'

export const START_DAYS = Object.freeze({ now: 0, months: 60, next_year: 365 })
export const LAST_DAYS = Object.freeze({ weeks: 45, quarters: 270, years: 730 })
export const DEFAULT_STARTS = 'now'
export const DEFAULT_LASTS = 'quarters'
const DAY = 864e5
const day = (iso) => Date.parse(`${iso}T00:00:00Z`)

/** The day the branches of a node happen, ISO; null for a resolved node with no date at all. Pure. */
export function happensOn(node, asOf) {
    if (node.status === 'resolved') return [node.resolved?.on, node.resolve_by].find(realDate) ?? null
    return realDate(node.resolve_by) && node.resolve_by > asOf ? node.resolve_by : asOf
}

/** When an effect of this node is active, in days from `asOf` → `{ from, to }`, or null when it cannot be dated. Pure. */
export function effectWindow(node, effect, asOf) {
    const on = happensOn(node, asOf)
    if (!on) return null
    const from = Math.round((day(on) - day(asOf)) / DAY) + (START_DAYS[effect.starts] ?? START_DAYS[DEFAULT_STARTS])
    return { from, to: from + (LAST_DAYS[effect.lasts] ?? LAST_DAYS[DEFAULT_LASTS]) }
}

/** A RESOLVED question's effect that has run its course by `asOf`: it leaves the scoring. Pure. */
export function effectEnded(node, effect, asOf) {
    if (node.status !== 'resolved' || !asOf) return false
    const w = effectWindow(node, effect, asOf)
    return w != null && w.to <= 0
}

/** The two windows, in days from the run (Roy, 2026-11-25): near = 0–6 months, far = 6–24 months. */
export const NEAR_DAYS = 183
export const FAR_DAYS = 730
/** A question is LONG past this many days: past the near window, so a May or June question does not take a long place. */
export const LONG_DAYS = 240

/**
 * The ONE window an effect counts in: where it STARTS (Roy, 2026-11-25 — prices move when the news lands; counted by
 * overlap, 65% of a build's effects sat in both). Already started → near, until it ends. → 'near' | 'far' | null (past the
 * far window). No run date, or an effect that cannot be dated → near. Pure.
 */
export function windowOf(node, effect, asOf) {
    const w = asOf ? effectWindow(node, effect, asOf) : null
    if (!w || w.from <= NEAR_DAYS) return 'near'
    return w.from <= FAR_DAYS ? 'far' : null
}

/** A LONG question: its answer is more than LONG_DAYS away (horizons §6). Pure. */
export function isLong(node, asOf) {
    return Boolean(asOf) && realDate(node.resolve_by) && (day(node.resolve_by) - day(asOf)) / DAY > LONG_DAYS
}

/**
 * The open long macro questions and which have no CHECKPOINT: no link from a live question that is not long → `{ open,
 * unlinked: [node_id] }`. Pure.
 */
export function longStatus(nodes, links, asOf) {
    const open = nodes.filter(n => n.status === 'live' && n.kind === 'open' && layerOf(n) === MACRO && isLong(n, asOf))
    const near = new Set(nodes.filter(n => n.status === 'live' && !isLong(n, asOf)).map(n => n.node_id))
    const linked = new Set(links.filter(l => l.live !== false && near.has(l.from.node_id)).map(l => l.to.node_id))
    return { open: open.length, unlinked: open.filter(n => !linked.has(n.node_id)).map(n => n.node_id) }
}

const index = (list, x, def) => { const i = list.indexOf(x); return i === -1 ? list.indexOf(def) : i }
/** Two runs' times for one effect → the LATER start and the SHORTER length; nothing when neither run gave any. Pure. */
export function agreeTimes(x, y) {
    if (!x.starts && !x.lasts && !y.starts && !y.lasts) return {}
    return {
        starts: STARTS[Math.max(index(STARTS, x.starts, DEFAULT_STARTS), index(STARTS, y.starts, DEFAULT_STARTS))],
        lasts: LASTS[Math.min(index(LASTS, x.lasts, DEFAULT_LASTS), index(LASTS, y.lasts, DEFAULT_LASTS))],
    }
}
