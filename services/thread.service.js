// Unified persistence for agent conversation threads (idea / portfolio / scanner,
// and later axl). Replaces the three divergent stores (stateless orchestrator,
// scanner_chats userId-blob, portfolio_chats) with one subject-independent thread:
// a conversation gets a threadId at the start, is persisted as a DRAFT once it
// crosses the agent's substantive floor (see thread.util.isSubstantive), and is
// LINKED to its artifact (subjectId) when an idea/portfolio/scan is generated.
//
// The pure tier/TTL/cap logic lives in thread.util.js and is unit-tested there.

import { getDb, stripId, stripIds } from '../providers/mongodb.provider.js'
import { logger } from './logger.service.js'
import { newThreadId, computeExpiry, draftsToEvict, deriveTitle, DRAFT_CAP } from './thread.util.js'

const LOG        = '[thread]'
const COLLECTION = 'threads'

export async function ensureThreadIndexes() {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).createIndexes([
            { key: { threadId: 1 }, unique: true },
            { key: { userId: 1, updatedAt: -1 } },
            { key: { userId: 1, agent: 1, subjectId: 1 } },
            // TTL: Mongo auto-deletes a thread once its expiresAt Date passes. Linked
            // threads carry expiresAt:null and are exempt (TTL skips non-Date fields).
            { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
        ])
    } catch (err) {
        logger.warn(LOG, 'ensureThreadIndexes failed', err.message)
    }
}

// Save/refresh a DRAFT thread. The caller has already decided the conversation is
// substantive (thread.util.isSubstantive over the agent's emitted phase/blocks).
// Upserts by threadId, refreshes the TTL, then enforces the per-user draft cap.
async function saveDraft({ threadId, userId, agent, messages, phase = null, subjectType = null, mandate = null, state = null }) {
    try {
        const db  = await getDb()
        const id  = threadId || newThreadId()
        const uid = String(userId)
        const now = Date.now()

        const set = {
            userId: uid, agent, messages, updatedAt: now,
            tier: 'draft', expiresAt: computeExpiry('draft', now),
            title: deriveTitle({ messages }),
        }
        if (phase != null)   set.phase = phase
        if (subjectType)     set.subjectType = subjectType
        if (mandate && typeof mandate === 'object') set.mandate = mandate
        // Agent-specific building state to restore a session (e.g. the idea agent's
        // analysisState). Opaque to the thread layer — stored and handed back verbatim.
        if (state && typeof state === 'object') set.state = state

        await db.collection(COLLECTION).updateOne(
            { threadId: id },
            { $set: set, $setOnInsert: { threadId: id, createdAt: now, subjectId: null } },
            { upsert: true }
        )

        // Enforce the per-user draft cap (evict oldest beyond the cap).
        const drafts = await db.collection(COLLECTION)
            .find({ userId: uid, tier: 'draft' }, { projection: { threadId: 1, updatedAt: 1, _id: 0 } })
            .toArray()
        const evict = draftsToEvict(drafts, DRAFT_CAP, id)
        if (evict.length) {
            await db.collection(COLLECTION).deleteMany({ threadId: { $in: evict }, tier: 'draft' })
        }
        return { ok: true, threadId: id }
    } catch (err) {
        logger.error(LOG, 'saveDraft failed', err)
        return { ok: false }
    }
}

// Promote a draft to LINKED when its conversation generates an artifact: stamp the
// subjectId, clear the TTL so it lives as long as the artifact, retitle from the
// artifact's name. No-op-safe if the thread doesn't exist (nothing was substantive).
async function linkToArtifact({ threadId, userId, subjectType = null, subjectId, artifactName = null }) {
    try {
        const db  = await getDb()
        const set = { tier: 'linked', subjectId: String(subjectId), expiresAt: null, updatedAt: Date.now() }
        if (subjectType) set.subjectType = subjectType
        if (artifactName) set.title = deriveTitle({ artifactName })
        const r = await db.collection(COLLECTION).updateOne(
            { threadId, userId: String(userId) },
            { $set: set }
        )
        return { ok: true, matched: r.matchedCount }
    } catch (err) {
        logger.error(LOG, 'linkToArtifact failed', err)
        return { ok: false }
    }
}

// Keep an unfinished draft: clear its TTL so it won't auto-expire.
async function pinThread({ threadId, userId }) {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).updateOne(
            { threadId, userId: String(userId), tier: 'draft' },
            { $set: { expiresAt: null, updatedAt: Date.now() } }
        )
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'pinThread failed', err)
        return { ok: false }
    }
}

async function getThread({ threadId, userId }) {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne({ threadId, userId: String(userId) })
        return doc ? stripId(doc) : null
    } catch (err) {
        logger.error(LOG, 'getThread failed', err)
        return null
    }
}

// A user's thread list (drafts + linked), newest first. Optionally filtered by agent.
// Messages are omitted from the list projection — the list is for browsing, not replay.
async function listThreads({ userId, agent = null }) {
    try {
        const db = await getDb()
        const q  = { userId: String(userId) }
        if (agent) q.agent = agent
        const docs = await db.collection(COLLECTION)
            .find(q, { projection: { messages: 0 } })
            .sort({ updatedAt: -1 })
            .limit(100)
            .toArray()
        return stripIds(docs)
    } catch (err) {
        logger.error(LOG, 'listThreads failed', err)
        return []
    }
}

async function discardThread({ threadId, userId }) {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).deleteOne({ threadId, userId: String(userId) })
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'discardThread failed', err)
        return { ok: false }
    }
}

export const threadService = {
    ensureThreadIndexes,
    saveDraft,
    linkToArtifact,
    pinThread,
    getThread,
    listThreads,
    discardThread,
}
