/**
 * Read and write which workspace the user is standing in. See api/workspace/workspace.model.js for
 * what a workspace is and why the record exists at all.
 *
 * CACHED, for the reason experience.service.js is: this is read on every turn of every agent (the
 * venue block carries it), while a user switches workspace a handful of times a day. The write busts
 * the entry immediately, so flipping to manual takes effect on the very next reply rather than a
 * minute later.
 *
 * Reads are BEST-EFFORT and degrade to null, which `resolveWorkspace` then reads as "not manual" —
 * i.e. exactly the paper-or-live answer the app gave before this record existed. A lookup failure
 * costs the manual distinction, never the turn.
 */

import { getDb } from '../providers/mongodb.provider.js'
import { logger } from './logger.service.js'
import { createTtlCache } from './ttlCache.util.js'
import { COLLECTION, buildWorkspaceDoc, isValidWorkspace } from '../api/workspace/workspace.model.js'
import { brokerService } from '../api/broker/broker.service.js'
import { activeWorkspace } from './venue.resolve.service.js'

const LOG = '[workspace]'

const TTL_MS = 60 * 1000   // shorter than experience's five minutes: a level changes twice in a
                           // user's life, a workspace changes several times an hour.
const _cache = createTtlCache({ ttlMs: TTL_MS, max: 500 })   // userId → { workspace } (wrapped, so
                                                             // a null choice still counts as a hit)

/**
 * What this user last chose, or null when they never have.
 *
 * Deliberately the RAW stored value, not the resolved workspace: the paper flag that outranks it
 * lives in the broker connections, and joining the two here would mean a second read on a path that
 * already holds those connections. `resolveWorkspace(connections.paper, stored)` is the join.
 *
 * @returns {Promise<'live'|'paper'|'manual'|null>}
 */
export async function getStoredWorkspace(userId, deps = {}) {
    if (!userId) return null
    const hit = _cache.get(userId)
    if (hit) return hit.workspace

    try {
        const { db = await getDb() } = deps
        const doc = await db.collection(COLLECTION).findOne({ userId }, { projection: { _id: 0, workspace: 1 } })
        const workspace = doc?.workspace ?? null
        _cache.set(userId, { workspace })
        return workspace
    } catch (err) {
        logger.warn(LOG, 'getStoredWorkspace failed', err.message)
        return null   // deliberately NOT cached: a transient failure must not pin a user to 'live'
    }
}

/**
 * Record the user's choice. Theirs to make and theirs alone — unlike the experience level there is
 * no inferred/declared split here, because no agent has any business deciding which book someone is
 * trading out of.
 *
 * @returns {Promise<{ok:boolean, workspace:?string, reason?:string}>}
 */
export async function setStoredWorkspace(userId, workspace, deps = {}) {
    if (!userId) return { ok: false, workspace: null, reason: 'no signed-in user' }
    if (!isValidWorkspace(workspace)) return { ok: false, workspace: null, reason: `unknown workspace: ${workspace}` }

    try {
        const { db = await getDb() } = deps
        const doc = buildWorkspaceDoc(userId, workspace)
        await db.collection(COLLECTION).updateOne({ userId }, { $set: doc }, { upsert: true })
        _cache.set(userId, { workspace })
        return { ok: true, workspace }
    } catch (err) {
        logger.warn(LOG, 'setStoredWorkspace failed', err.message)
        return { ok: false, workspace: null, reason: err.message }
    }
}

/**
 * The workspace the user is standing in, resolved — the paper flag joined with their stored choice.
 *
 * For callers that need the answer and do NOT already hold the broker connections. `getTradingContext`
 * deliberately does not use this: it reads the connections anyway for the accounts, so going through
 * here would fetch them twice. Both funnel through the same `activeWorkspace` rule, which is the part
 * that must not drift; only the fetching differs.
 *
 * Best-effort in both legs — an unreadable connection list or choice degrades to 'live', never throws.
 *
 * @returns {Promise<'live'|'paper'|'manual'>}
 */
export async function getActiveWorkspace(userId, deps = {}) {
    if (!userId) return 'live'
    const { broker: svc = brokerService, stored = getStoredWorkspace } = deps
    try {
        const [connections, choice] = await Promise.all([
            svc.listConnections(userId).catch(() => ({})),
            stored(userId).catch(() => null),
        ])
        return activeWorkspace(connections, choice)
    } catch (err) {
        logger.warn(LOG, 'getActiveWorkspace failed', err.message)
        return 'live'
    }
}

/** Test seam — drop a cached choice so one test is not answered by another's write. */
export function _clearWorkspaceCache() { _cache.clear?.() }
