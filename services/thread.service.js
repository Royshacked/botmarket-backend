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
async function saveDraft({ threadId, userId, agent, messages, phase = null, subjectType = null, mandate = null, state = null, pipeline = null }) {
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
        // WHICH DESK this conversation belongs to, when it belongs to one. An agent is shared between
        // desks — Argus screens for a portfolio build and also scans standalone — so `agent` alone
        // cannot say what the user left unfinished, nor which other doors to that agent must close
        // while this one holds it. Null for a conversation opened at a desk with no pipeline.
        if (pipeline) set.pipeline = pipeline

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

/**
 * Is this conversation waiting on the USER? True when the last thing said was the assistant's.
 *
 * Derived from the messages rather than stored as a flag, because the messages ARE the truth: a
 * second field saying whose turn it is would be a copy of them, and a copy can rot. Pure.
 */
export function _yourTurn(messages) {
    const last = (Array.isArray(messages) ? messages : []).at(-1)
    return last?.role === 'assistant'
}

/**
 * UNFINISHED WORK, per desk — what the route badges read.
 *
 * A conversation the user walked away from is already here as a DRAFT thread, resumable, surviving
 * whatever the client tore down when they left. The only thing missing was that nothing outside the
 * desk ever said so, which is how a half-finished portfolio quietly becomes invisible.
 *
 * WHOSE TURN IT IS is DERIVED, not stored: a draft whose last message is the assistant's is waiting
 * on the user. Deriving it means there is no second piece of state to keep in step with the
 * conversation — the messages are the truth, and a stored flag would be a copy of them that can rot.
 *
 * Only DRAFTS count. A linked thread produced its artifact and is finished business; badging it would
 * mark every book the user ever built as outstanding.
 *
 * @returns {Promise<Array<{agent:string, pipeline:string|null, threadId:string, title:string|null,
 *                           updatedAt:number, yourTurn:boolean}>>}
 */
async function listUnfinished({ userId }) {
    try {
        const db = await getDb()
        const docs = await db.collection(COLLECTION)
            .find(
                { userId: String(userId), tier: 'draft' },
                // The last message only: the list is a badge, not a replay, and pulling whole
                // conversations to decide whose turn it is would read every thread in full.
                { projection: { threadId: 1, agent: 1, pipeline: 1, title: 1, updatedAt: 1, phase: 1, messages: { $slice: -1 } } },
            )
            .sort({ updatedAt: -1 })
            .limit(50)
            .toArray()

        return docs.map(d => ({
            threadId:  d.threadId,
            agent:     d.agent,
            pipeline:  d.pipeline ?? null,
            title:     d.title ?? null,
            phase:     d.phase ?? null,
            updatedAt: d.updatedAt ?? null,
            yourTurn:  _yourTurn(d.messages),
        }))
    } catch (err) {
        logger.error(LOG, 'listUnfinished failed', err)
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
    listUnfinished,
    discardThread,
}
