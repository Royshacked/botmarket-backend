// WHEN AN EFFECT IS ACTIVE (docs/design/situation-network-horizons.md §3).
//
// An effect starts some time after its branch HAPPENS (`starts`) and lasts some time (`lasts`). The branch happens on the
// day its question resolved; while it is live, on its resolve-by date (the run's date when that has passed, or there is
// none). The labels are the mapping's; the days are ours. An effect mapped before 2026-11-25 has neither: `now` +
// `quarters`.

import { STARTS, LASTS, realDate } from './model.js'

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

const index = (list, x, def) => { const i = list.indexOf(x); return i === -1 ? list.indexOf(def) : i }
/** Two runs' times for one effect → the LATER start and the SHORTER length; nothing when neither run gave any. Pure. */
export function agreeTimes(x, y) {
    if (!x.starts && !x.lasts && !y.starts && !y.lasts) return {}
    return {
        starts: STARTS[Math.max(index(STARTS, x.starts, DEFAULT_STARTS), index(STARTS, y.starts, DEFAULT_STARTS))],
        lasts: LASTS[Math.min(index(LASTS, x.lasts, DEFAULT_LASTS), index(LASTS, y.lasts, DEFAULT_LASTS))],
    }
}
