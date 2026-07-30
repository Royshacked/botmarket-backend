/**
 * Reads and writes for the objective — the user's stated goal, captured by Axl at intake.
 * See api/objectives/objective.model.js for the shape and why it exists.
 *
 * ONE OPEN OBJECTIVE PER USER, enforced on write: saving a new one supersedes the previous rather
 * than editing it. Restating the goal is a new statement, not a correction of the old one, and
 * keeping the old row makes the trail readable later ("they wanted 5% in a week, then 2% in a
 * month"). The alternative — mutating in place — loses that for no gain.
 *
 * Expiry is LAZY. A goal with a deadline in the past is stale by definition, and a cron to notice
 * that would be a scheduled job whose only output is a status field nobody is waiting on. Instead
 * every read sweeps its own user's stale rows first, so a desk can never be handed a goal whose
 * deadline has passed.
 */

import { getDb } from '../providers/mongodb.provider.js'
import { logger } from './logger.service.js'
import { COLLECTION, buildObjectiveDoc, todayISO } from '../api/objectives/objective.model.js'

const LOG = '[objectives]'

/**
 * Persist what Axl captured, superseding whatever was open.
 * Throws (via buildObjectiveDoc) when the goal isn't actually stated — no target, or no horizon.
 *
 * @param {string} userId
 * @param {object} fields  { target, horizon, risk, scope, symbol }
 * @returns {Promise<object>} the stored objective
 */
export async function createObjective(userId, fields, deps = {}) {
    const { db = await getDb(), now = new Date() } = deps
    const doc = buildObjectiveDoc(userId, fields, now)

    // Supersede first. If the insert then fails the user is left with no open objective rather than
    // two, which is the safer of the two wrong states — a desk reading nothing asks, a desk reading
    // the wrong one of two acts on a goal the user has moved on from.
    await db.collection(COLLECTION).updateMany(
        { userId, status: 'open' },
        { $set: { status: 'superseded', updatedAt: doc.createdAt } },
    )
    await db.collection(COLLECTION).insertOne({ ...doc })

    logger.info(LOG, 'objective saved', { userId, id: doc.id, days: doc.horizon.days, scope: doc.scope })
    return doc
}

/**
 * The user's live goal, or null. Sweeps their own stale rows on the way past.
 * Best-effort by design: a desk that can't read the objective must still answer, so a DB problem
 * degrades to "no objective" rather than failing the turn.
 */
export async function getOpenObjective(userId, deps = {}) {
    if (!userId) return null
    try {
        const { db = await getDb(), now = new Date() } = deps
        const today = todayISO(now)

        // Sweep before read, so a deadline that passed overnight can't be served once more.
        await db.collection(COLLECTION).updateMany(
            { userId, status: 'open', 'horizon.until': { $lt: today } },
            { $set: { status: 'expired', updatedAt: now.getTime() } },
        )

        const doc = await db.collection(COLLECTION).findOne(
            { userId, status: 'open' },
            { sort: { createdAt: -1 }, projection: { _id: 0 } },
        )
        return doc ?? null
    } catch (err) {
        logger.warn(LOG, 'getOpenObjective failed', err.message)
        return null
    }
}

/**
 * Record which desk the user was handed to. Deliberately does NOT close the objective — they are
 * at the desk to work on this goal, so it must still be readable there.
 */
export async function markRouted(id, desk, deps = {}) {
    if (!id || !desk) return null
    try {
        const { db = await getDb(), now = new Date() } = deps
        const ts = now.getTime()
        await db.collection(COLLECTION).updateOne(
            { id, status: 'open' },
            { $set: { routedTo: desk, routedAt: ts, updatedAt: ts } },
        )
        return id
    } catch (err) {
        logger.warn(LOG, 'markRouted failed', err.message)
        return null
    }
}

/** Retire an objective — the user abandoned it, or it was met. */
export async function closeObjective(id, reason = 'expired', deps = {}) {
    if (!id) return null
    try {
        const { db = await getDb(), now = new Date() } = deps
        await db.collection(COLLECTION).updateOne(
            { id },
            { $set: { status: reason, updatedAt: now.getTime() } },
        )
        return id
    } catch (err) {
        logger.warn(LOG, 'closeObjective failed', err.message)
        return null
    }
}
