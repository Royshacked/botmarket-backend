// Argus's conversation-long mode. Since 2026-11-09 there is ONE: the single pick for Mentor.
//
// Argus's list-building chat — the trading and investing scans, the radar cut, the saved lists and their edits —
// was archived that day (Roy; archive/README.md). What is left of the desk is the hand-off Mentor opens when the
// user has no name: find ONE ticker, emit <argus_pick>, the chain carries it back. So the mode is not read from
// the caller any more, it is stated — whatever a route, an old session or a stale client hands in, Argus is in
// hand-off mode for Mentor, because there is no other mode left for him to be in. An old agentState holding a
// pendingScan or a radar board is simply not read.

/** The mode fields — fixed. Any argument a caller still passes is ignored. */
export function scannerMode() {
    return { handoff: true, handoffTo: 'mentor' }
}
