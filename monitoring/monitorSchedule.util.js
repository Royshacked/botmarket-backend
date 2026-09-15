/**
 * The persisted cadence the idea-tier loops share — entry.monitor (armed → hit) and exit.monitor
 * (in position → closed). Both are dueLoop callers over `monitor_state.next_check_at`, both floor
 * the gap at a minute, both idle a venue-less entity for an hour, and both sleep an intraday leg
 * until the venue opens. Each had its own copy of every one of those, forty lines apart in two
 * files that were written as siblings on purpose; the constants and arithmetic live here so the
 * two loops can never disagree about when a document is next due. What stays in each loop is what
 * makes it that loop: which documents, and the check.
 *
 * Talos is NOT a caller. It keeps its own schedule through the monitor journal (monitorJournal /
 * makePersist) because its cadence is a judgment its model writes down, not a timeframe rule.
 */

/** The field dueLoop selects on for these loops. */
export const NEXT_CHECK_FIELD = 'monitor_state.next_check_at'

export const POLL_INTERVAL_MS = 60_000
// Longer than the poll interval, like every dueLoop caller: the lease horizon IS the check timeout,
// and a shorter one lets the next tick re-select an entity whose abandoned check is still running —
// which for these loops means a second order plan / confirm card, or two closing orders for one stop.
export const CHECK_TIMEOUT_MS = 90_000

// The floor on how often ONE entity is re-read. A 1-minute leg wants a 1-minute cadence and that is
// as fast as this goes; the poll interval is the same, so nothing is gained by asking for less.
export const MIN_GAP_MS = 60_000
// An entity the loop cannot act on at all (no venue, nothing to evaluate) still gets re-read, but at
// a cost that rounds to nothing — the venue can come back, and an armed idea or an open stop that
// silently stopped being watched is the bug both loops exist to end.
export const IDLE_GAP_MS = 60 * 60_000

/**
 * When this entity next wants reading, as the ISO string the field stores. Floored at MIN_GAP_MS so
 * a bound one second away cannot spin; a non-number gap reads as 0 and lands on the floor.
 * @param {number} nowMs
 * @param {number} gapMs
 * @returns {string}
 */
export function nextCheckAt(nowMs, gapMs) {
    return new Date(nowMs + Math.max(MIN_GAP_MS, Number(gapMs) || 0)).toISOString()
}

/**
 * How long to sleep a leg that needs a live tape while its venue is shut: until the open when the
 * market status knows it, else the leg's own cadence. Pure.
 * @param {{ nextOpenMs?: number }|null} status  getMarketStatus(...)
 * @param {number} nowMs
 * @param {number} fallbackMs
 * @returns {number}
 */
export function untilOpenMs(status, nowMs, fallbackMs) {
    return Number.isFinite(status?.nextOpenMs) && status.nextOpenMs > nowMs
        ? status.nextOpenMs - nowMs
        : fallbackMs
}
