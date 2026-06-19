/**
 * Time-window condition evaluator.
 *
 * A `time` leaf gates a phase on the real-world clock at evaluation time:
 *   { type: 'time', after?: <ISO-8601 | epoch>, before?: <ISO-8601 | epoch> }
 *
 * pass = (no `after`  OR now >= after)
 *    AND (no `before` OR now <= before)
 *
 * Both bounds empty → the condition is *ignored* (always passes), so an author
 * can drop in a time leaf and fill the dates in later without blocking entry.
 *
 * Pure function — no I/O, no Claude calls.
 */

import { logger } from '../../services/logger.service.js'

const LOG = '[time.evaluator]'

/** Parse an ISO-8601 string or epoch (ms or s) into epoch ms, or null when empty/invalid. */
function toMs(v) {
    if (v == null || v === '') return null
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v   // tolerate seconds
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
}

/**
 * Evaluate a time-window leaf against the wall clock.
 *
 * @param {{ after?: string|number, before?: string|number }} leaf
 * @param {number} now  ms epoch (defaults to Date.now())
 * @returns {boolean}
 */
export function evaluateTime(leaf, now = Date.now()) {
    const after  = toMs(leaf?.after)
    const before = toMs(leaf?.before)

    // Non-empty but unparseable input: warn, but don't block on a bad string.
    if (after === null && leaf?.after)   logger.warn(LOG, `Ignoring unparseable "after": ${leaf.after}`)
    if (before === null && leaf?.before) logger.warn(LOG, `Ignoring unparseable "before": ${leaf.before}`)

    if (after === null && before === null) return true   // empty → ignored

    return (after === null || now >= after) && (before === null || now <= before)
}
