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
const COLLECTION = 'agent_contexts'
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
        const doc  = {
            ...key,
            messages:  capSealed([...(prev?.messages ?? []), ...toContextMessages(messages, now)]),
            summary:   typeof summary === 'string' && summary.trim() ? summary.trim() : (prev?.summary ?? null),
            // References, not payloads (§3.10); the newest MAX_SEALED_ARTIFACTS are plenty to reopen on.
            artifacts: [...(prev?.artifacts ?? []), ...(Array.isArray(artifacts) ? artifacts : [])].slice(-MAX_SEALED_ARTIFACTS),
            sealedAt:  prev?.sealedAt ?? now,
            updatedAt: now,
        }
        await db.collection(COLLECTION).replaceOne(key, doc, { upsert: true })
        return { context: doc }
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

    return { ensureIndexes, seal, load, removeFor }
}

export const agentContextService = makeAgentContextService()
