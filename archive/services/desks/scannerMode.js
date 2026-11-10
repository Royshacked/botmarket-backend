// Argus's conversation-long mode — validated the same way whichever caller supplies it: the desk (a turn, a route,
// a reopened list) and its session edits. Its own module so the desk and services/desks/actions/scanner.actions.js
// both import it without importing each other (plan phase 8a CR).

// A radar board rides on the session turn and is KEPT in the agent's state for the cut (and for the run ids the
// saved list is stamped with), so it is capped: the universe is a few dozen names, this is a guard, not a limit.
const RADAR_MAX = 200

/** A radar board from a session turn: an object with a list of candidate objects, capped. Null otherwise. */
export function radarBoard(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.candidates)) return null
    const candidates = raw.candidates.filter(c => c && typeof c === 'object' && !Array.isArray(c)).slice(0, RADAR_MAX)
    if (!candidates.length) return null
    return { ...raw, candidates, runIds: Array.isArray(raw.runIds) ? raw.runIds.slice(0, RADAR_MAX).map(String) : [] }
}

/** The mode fields, validated — the same whitelist whichever caller supplies them. */
export function scannerMode(raw = {}) {
    const { editList, handoff, handoffTo, radar, radarBoard: board, profile } = raw ?? {}
    return {
        editList:   editList && typeof editList === 'object' ? editList : null,
        handoff:    handoff === true,
        // Which desk the pick goes back to. Whitelisted rather than passed through: this string lands
        // in the prompt, and an unknown value degrades to the generic phrasing instead of putting
        // whatever the body carried in front of the user.
        handoffTo:  handoffTo === 'mentor' ? handoffTo : null,
        // The Events radar handed over a universe: the mode flag, and the board it applies to. The
        // board is built server-side (aetherScanUniverse) and handed straight back, so the only thing
        // worth checking here is its shape — the prompt renders whatever it holds.
        radar:      radar === true,
        radarBoard: board && typeof board === 'object' ? board : null,
        profile:    profile === 'investing' ? 'investing' : 'trading',
    }
}
