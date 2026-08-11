/**
 * In-flight agent turns, so STOP can be told apart from WALKING AWAY.
 *
 * These used to be the same signal. The SSE layer aborted the model call on `res.close`, and both
 * gestures close the response — so leaving a desk mid-answer killed the turn, and the work the user
 * had already paid for was lost along with it. That is the whole reason a desk conversation could not
 * be left running.
 *
 * Now a turn carries an id. Closing the connection means only "nobody is watching"; aborting requires
 * someone to say so, through this registry. The turn then finishes and persists itself either way, and
 * the user finds it waiting when they come back.
 *
 * IN MEMORY on purpose: an AbortController cannot be serialised, and a turn cannot outlive the process
 * running it — so a registry that survived a restart would only ever describe turns that are already
 * dead. A restart ends its turns, which is honest and is what a torn-down socket already meant.
 */

import { logger } from '../../services/logger.service.js'

const LOG = '[turns]'

/** turnId → { ac, startedAt, userId } */
const _turns = new Map()

// A turn that never reported finishing (a thrown handler that skipped its own cleanup) would sit here
// forever holding a reference. Swept lazily on registration rather than on a timer: the map is small,
// and a sweep that only runs when something new arrives cannot itself leak.
const MAX_TURN_AGE_MS = 30 * 60_000

function _sweep(now) {
    for (const [id, t] of _turns) {
        if (now - t.startedAt > MAX_TURN_AGE_MS) _turns.delete(id)
    }
}

/**
 * Register an in-flight turn. Returns a release fn — call it when the turn ends, however it ends.
 * A turn with no id is not registered and cannot be stopped remotely; it still runs.
 */
export function registerTurn(turnId, ac, userId = null) {
    if (!turnId) return () => {}
    const id = String(turnId)
    _sweep(Date.now())
    _turns.set(id, { ac, startedAt: Date.now(), userId: userId != null ? String(userId) : null })
    return () => { _turns.delete(id) }
}

/**
 * Stop a turn on the user's say-so. Owner-scoped: a turn id is guessable enough that stopping someone
 * else's work must not be possible.
 * @returns {boolean} whether a turn of this user's was actually stopped
 */
export function stopTurn(turnId, userId) {
    const t = _turns.get(String(turnId ?? ''))
    if (!t) return false
    if (t.userId != null && userId != null && t.userId !== String(userId)) return false
    t.ac.abort()
    _turns.delete(String(turnId))
    logger.info(LOG, `turn ${turnId} stopped by the user`)
    return true
}

/** For tests and diagnostics. */
export function _turnCount() { return _turns.size }
