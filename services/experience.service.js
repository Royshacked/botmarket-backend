/**
 * Read and write the user's experience level. See api/experience/experience.model.js for what it
 * is, the one hard line, and why the asymmetry exists.
 *
 * THE GUARD IS HERE, not in a prompt. `maySet` decides whether a given source may set a given
 * level, and a rejected write is a no-op that says so — so a model that decides someone "sounds
 * experienced" cannot make that stick no matter how the prompt is worded.
 *
 * CACHED, because this is read on every turn of every agent. A level changes perhaps twice in a
 * user's life, so a short TTL costs nothing and saves a round trip per turn; the write busts it
 * immediately, so "talk to me normally" takes effect on the very next reply rather than a minute
 * later. Same createTtlCache the portfolio snapshot uses.
 *
 * Reads are BEST-EFFORT and degrade to null. A level is a nicety; failing a user's turn because we
 * could not look up how to talk to them would be absurd. Null is also the honest answer — it means
 * "no view", and no view is what an un-inferred user has.
 */

import { getDb } from '../providers/mongodb.provider.js'
import { logger } from './logger.service.js'
import { createTtlCache } from './ttlCache.util.js'
import { COLLECTION, buildExperienceDoc, maySet } from '../api/experience/experience.model.js'

const LOG = '[experience]'

const TTL_MS = 5 * 60 * 1000
const _cache = createTtlCache({ ttlMs: TTL_MS, max: 500 })   // userId → { level } (wrapped, so a
                                                             // null level still counts as a hit)

/**
 * This user's level, or null when we have no view.
 * @returns {Promise<'beginner'|'experienced'|null>}
 */
export async function getExperienceLevel(userId, deps = {}) {
    if (!userId) return null
    const hit = _cache.get(userId)
    if (hit) return hit.level

    try {
        const { db = await getDb() } = deps
        const doc = await db.collection(COLLECTION).findOne({ userId }, { projection: { _id: 0, level: 1 } })
        const level = doc?.level ?? null
        _cache.set(userId, { level })
        return level
    } catch (err) {
        logger.warn(LOG, 'getExperienceLevel failed', err.message)
        return null   // deliberately NOT cached: a transient failure must not pin a user to "no view"
    }
}

/**
 * Set the level, if this source is allowed to set it.
 *
 * @param {string} userId
 * @param {'beginner'|'experienced'|null} level
 * @param {'inferred'|'declared'} source
 * @returns {Promise<{ok:boolean, level:?string, reason?:string}>}
 */
export async function setExperienceLevel(userId, level, source, deps = {}) {
    if (!userId) return { ok: false, level: null, reason: 'no signed-in user' }

    if (!maySet(level, source)) {
        // The asymmetry, refused out loud. The caller gets a reason it can act on rather than a
        // silent no-op, so a model that tried to infer "experienced" learns that it must be the
        // user's own word.
        logger.info(LOG, 'refused', { userId, level, source })
        return {
            ok: false,
            level: null,
            reason: source === 'inferred' && level !== 'beginner'
                ? 'only "beginner" may be inferred — anything else has to come from the user in their own words'
                : `"${level}" cannot be set by ${source}`,
        }
    }

    try {
        const { db = await getDb(), now = new Date() } = deps
        const doc = buildExperienceDoc(userId, level, source, now)
        await db.collection(COLLECTION).updateOne({ userId }, { $set: doc }, { upsert: true })
        // Bust before returning, so the very next turn reads the new level.
        _cache.delete(userId)
        logger.info(LOG, 'set', { userId, level, source })
        return { ok: true, level }
    } catch (err) {
        logger.warn(LOG, 'setExperienceLevel failed', err.message)
        return { ok: false, level: null, reason: err.message }
    }
}

/** Drop a cached level — for tests and for any out-of-band write. */
export function invalidateExperience(userId) {
    _cache.delete(userId)
}
