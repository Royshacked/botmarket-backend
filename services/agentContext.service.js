// Sealed agent context — an agent's conversation, kept with the entity it produced
// (docs/design/unified-chat.md §6.2, plan phase 3 — §5.1 D2).
//
//   agent_contexts  { userId, kind, entityId, agent, messages, summary, artifacts, sealedAt, updatedAt }
//                   one row per { userId, kind, entityId, agent }
//
// When work ends in an entity (Generate), that agent's turns leave the session and are sealed here;
// editing the entity later loads them back into the live chat, and the edit's turns are appended.
//
// A COLLECTION KEYED BY THE ENTITY, not a field on it. It is the same for an entity the user owns (a
// setup, a scan, a book) and a house one (coverage, an industry view): coverage has no owner and one
// thesis per symbol, so an admin's conversation written onto it would travel with the house document
// to the other admin. Here each user's context stays theirs. The entities' own schemas do not change.
//
// Built as a factory over `getDb` so the tests run it on tests/helpers/memDb.js.

import { getDb as _defaultGetDb, stripId } from '../providers/mongodb.provider.js'
import { logger } from './logger.service.js'
import { isAgent, isContextKind, toContextMessages, capSealed } from './session.util.js'

const LOG        = '[agentContext]'
export const COLLECTION = 'agent_contexts'
const MAX_SEALED_ARTIFACTS = 50

const _key = ({ userId, kind, entityId, agent }) =>
    ({ userId: String(userId), kind, entityId: String(entityId), agent })

function _invalid({ userId, kind, entityId, agent }) {
    if (!userId || !entityId) return 'userId and entityId are required'
    if (!isContextKind(kind)) return 'invalid kind'
    if (!isAgent(agent)) return 'invalid agent'
    return null
}

export function makeAgentContextService({ getDb = _defaultGetDb } = {}) {

    async function ensureIndexes() {
        try {
            const db = await getDb()
            await db.collection(COLLECTION).createIndex({ userId: 1, kind: 1, entityId: 1, agent: 1 }, { unique: true })
            // Cleanup when an entity is deleted reads by the entity alone — every user's row for it.
            await db.collection(COLLECTION).createIndex({ kind: 1, entityId: 1 })
        } catch (err) {
            logger.warn(LOG, 'ensureIndexes failed', err.message)
        }
    }

    /**
     * Seal an agent's turns onto an entity. A second seal APPENDS — an edit adds to the history it
     * reopened; it does not replace it. The newest MAX_SEALED_MESSAGES are kept; what is older is the
     * summary's job, and a newer summary replaces the older one.
     */
    async function seal({ userId, kind, entityId, agent, messages, summary = null, artifacts = [] }) {
        const invalid = _invalid({ userId, kind, entityId, agent })
        if (invalid) return { reason: 'invalid_context', error: invalid }
        const db   = await getDb()
        const key  = _key({ userId, kind, entityId, agent })
        const now  = Date.now()
        const prev = await db.collection(COLLECTION).findOne(key)
        const all  = [...(prev?.messages ?? []), ...toContextMessages(messages, now)]
        const kept = capSealed(all)
        const doc  = {
            ...key,
            messages:  kept,
            summary:   typeof summary === 'string' && summary.trim() ? summary.trim() : (prev?.summary ?? null),
            // References, not payloads (§3.10); the newest MAX_SEALED_ARTIFACTS are plenty to reopen on.
            artifacts: [...(prev?.artifacts ?? []), ...(Array.isArray(artifacts) ? artifacts : [])].slice(-MAX_SEALED_ARTIFACTS),
            sealedAt:  prev?.sealedAt ?? now,
            updatedAt: now,
            // A migrated context's record of what the migration put in front (importLegacy) survives a live seal — the
            // cap drops from the front, so the count shrinks by what it dropped. Without it a restore cannot tell them apart.
            ...(prev?.legacy ? { legacy: prev.legacy, legacyAdded: Math.max(0, (prev.legacyAdded ?? 0) - (all.length - kept.length)) } : {}),
        }
        await db.collection(COLLECTION).replaceOne(key, doc, { upsert: true })
        return { context: doc }
    }

    /**
     * A LEGACY conversation moved onto its entity (unified-chat plan phase 9 — a linked thread, a setup's old
     * `chat_state.messages`, a scan's `chat`, a book's `messages`). It is OLDER than anything sealed here since, so it
     * goes IN FRONT of what the context already holds. `sources` name where it came from ("thread:thr_…", "book:p1")
     * and are kept on the doc: when every one is already in, the import is skipped, so a migration re-run never
     * duplicates turns. One entity's several sources are merged BEFORE this (the migration's mergeSources — a book's
     * thread and its own messages were often the same chat), so this only prepends.
     *
     * `legacyAdded` counts the legacy messages at the FRONT of `messages` (after the cap, which drops the oldest — legacy
     * — ones first), so a restore can take exactly those off and keep anything sealed since (restoreUnifiedChat).
     * @returns {Promise<{ imported: boolean, reason?: string }>}
     */
    async function importLegacy({ userId, kind, entityId, agent, messages, sources = [], at = null }) {
        const invalid = _invalid({ userId, kind, entityId, agent })
        if (invalid) return { imported: false, reason: invalid }
        const from = (Array.isArray(sources) ? sources : [sources]).filter(Boolean)
        if (!from.length) return { imported: false, reason: 'sources are required' }
        const db   = await getDb()
        const key  = _key({ userId, kind, entityId, agent })
        const prev = await db.collection(COLLECTION).findOne(key)
        if (from.every(s => prev?.legacy?.includes(s))) return { imported: false, reason: 'already_imported' }
        const when = Number.isFinite(at) ? at : Date.now()
        const old  = toContextMessages(messages, when)
        if (!old.length) return { imported: false, reason: 'no_messages' }
        const all     = [...old, ...(prev?.messages ?? [])]
        const kept    = capSealed(all)
        const dropped = all.length - kept.length
        await db.collection(COLLECTION).replaceOne(key, {
            ...key,
            messages:    kept,
            summary:     prev?.summary ?? null,
            artifacts:   prev?.artifacts ?? [],
            sealedAt:    prev?.sealedAt ?? when,
            updatedAt:   Date.now(),
            legacy:      [...new Set([...(prev?.legacy ?? []), ...from])],
            legacyAdded: Math.max(0, old.length + (prev?.legacyAdded ?? 0) - dropped),
        }, { upsert: true })
        return { imported: true }
    }

    /** This user's sealed context for an entity, or null. */
    async function load({ userId, kind, entityId, agent }) {
        if (_invalid({ userId, kind, entityId, agent })) return null
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne(_key({ userId, kind, entityId, agent }))
        return doc ? stripId(doc) : null
    }

    /** The entity is gone: every user's context for it goes with it. */
    async function removeFor({ kind, entityId }) {
        if (!isContextKind(kind) || !entityId) return { deleted: 0 }
        const db = await getDb()
        const r  = await db.collection(COLLECTION).deleteMany({ kind, entityId: String(entityId) })
        return { deleted: r.deletedCount ?? 0 }
    }

    return { ensureIndexes, seal, importLegacy, load, removeFor }
}

export const agentContextService = makeAgentContextService()

/**
 * The delete paths' hook: when an entity's delete SUCCEEDED, every user's sealed context for it goes too.
 * Fire-and-forget and never fails the delete; hands the delete's own result straight back, so a service
 * call can be wrapped in place: `remove: async (id, u) => forgetIfDeleted('setup', id, await del(id, u))`.
 */
export function forgetIfDeleted(kind, entityId, result, svc = agentContextService) {
    // A delete that reports a count must have removed something: `ok` with nothing deleted is a
    // portfolioId that was not this user's (or already gone), and wiping every user's context for it
    // would let anyone erase another user's sealed conversation.
    if (result?.ok && (result.deleted === undefined || result.deleted > 0)) {
        svc.removeFor({ kind, entityId }).catch(err => logger.warn(LOG, 'context cleanup failed (the entity is deleted)', err.message))
    }
    return result
}
