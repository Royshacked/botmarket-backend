/**
 * How to TALK to this user — one durable fact, held per user.
 *
 * Every agent in this app writes practitioner-to-practitioner. That is right for the reader it was
 * written for and wrong for a beginner, who now meets an Axl that will explain what a stop is and
 * then gets handed to a desk assuming they already knew. This record is what lets each desk adapt
 * its own voice instead.
 *
 * ── THE ONE HARD LINE ─────────────────────────────────────────────────────────
 * The level changes how a desk SPEAKS. It never changes what a desk DECIDES. Same analysis, same
 * levels, same size, same risk — different words. The moment it touches a number it stops being a
 * voice parameter and becomes an input to a decision, and then it falls under the rule in
 * objective.model.js: things that feed decisions are stated by the user, never inferred.
 *
 * ── THE ASYMMETRY, AND WHY IT EXISTS ──────────────────────────────────────────
 * `beginner` may be INFERRED from how someone writes. `experienced` may only be DECLARED.
 *
 * Not squeamishness — the costs genuinely differ. Treating an expert as a beginner is mildly
 * irritating and self-correcting: they say "talk to me normally" and it is fixed in one turn.
 * Treating a beginner as an expert puts a wall of jargon in front of a Confirm button, and they
 * cannot tell anything went wrong. So the app is allowed to err in exactly one direction.
 *
 * The guard lives in the service rather than the prompt (see experience.service.js). A prompt
 * instruction can be ignored by a model; a guard cannot.
 *
 * NOT stored on the user document, deliberately. `stripUser` returns every field it does not
 * explicitly remove, and `GET /api/users` has no ownership gating — so a level on the user doc
 * would be readable by every authenticated user. And NOT in `preferences`, which the client owns
 * and rewrites wholesale from localStorage, destroying anything the server put there.
 */

import { getDb } from '../../providers/mongodb.provider.js'

export const COLLECTION = 'user_experience'

export const LEVELS = ['beginner', 'experienced']
export const SOURCES = ['inferred', 'declared']

/** The only level the app may conclude on its own. */
export const INFERABLE_LEVELS = ['beginner']

export function isValidLevel(level) {
    return LEVELS.includes(level)
}

/**
 * May this source set this level?
 * The asymmetry, as one expression — imported by the service and asserted by the tests, so there
 * is exactly one place it can drift.
 */
export function maySet(level, source) {
    if (!SOURCES.includes(source)) return false
    if (level === null) return source === 'declared'   // only the user may clear it
    if (!isValidLevel(level)) return false
    return source === 'declared' || INFERABLE_LEVELS.includes(level)
}

export function buildExperienceDoc(userId, level, source, now = new Date()) {
    return {
        userId,
        level,
        source,
        updatedAt: now.getTime(),
    }
}

export async function ensureExperienceIndexes() {
    try {
        const db = await getDb()
        // One row per user — the record is a current state, not a history.
        await db.collection(COLLECTION).createIndex({ userId: 1 }, { unique: true })
    } catch (err) {
        console.warn('[experience] ensureExperienceIndexes failed:', err.message)
    }
}
