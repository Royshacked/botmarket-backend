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
import { newThreadId, computeExpiry, draftsToEvict, deriveTitle, pipelineDraftsQuery, DRAFT_CAP } from './thread.util.js'

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

// The last thing said in a conversation, as `{ role, text }`.
//
// The same message `_yourTurn` reads, and it was already being pulled out of Mongo and thrown away:
// the projection slices it off every draft, the flag keeps whose turn it was, and the words went in
// the bin. They are what a desk actually DID — "the NVDA thesis is published, PT 210 vs the Street's
// 185" — and reception has no other way to know it. Axl reads this on the walk back (AxlHub
// `_sendReturn`) so the sentence that closes a trip is the desk's own, not a guess assembled from
// the book afterwards.
//
// CAPPED, and that is not only about bytes: it becomes one clause of a note inside a prompt. A desk's
// closing turn can be a page of plan, and a page quoted back at reception buries the question the
// return turn exists to ask. Hard-wrapping is collapsed for the same reason — this is a quote in a
// sentence, not a document.
const LAST_LINE_MAX = 400
export function _lastLine(messages) {
    const last = (Array.isArray(messages) ? messages : []).at(-1)
    if (!last || typeof last.content !== 'string') return null
    // A hidden row is history-only (the note a chart turn leaves behind) — never something "said".
    if (last.hidden) return null
    const text = last.content.replace(/\s+/g, ' ').trim().slice(0, LAST_LINE_MAX)
    return text ? { role: last.role === 'assistant' ? 'assistant' : 'user', text } : null
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
 * WHAT WAS LAST SAID rides along for the same reason, off the same message: the badge needed only
 * whose turn it was, but reception needs the words — see _lastLine.
 *
 * @returns {Promise<Array<{agent:string, pipeline:string|null, threadId:string, title:string|null,
 *                           updatedAt:number, yourTurn:boolean,
 *                           lastLine:{role:'user'|'assistant', text:string}|null}>>}
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
            // What was last said there, `{ role, text }` — free, off the message the flag above
            // already read. See _lastLine.
            lastLine:  _lastLine(d.messages),
        }))
    } catch (err) {
        logger.error(LOG, 'listUnfinished failed', err)
        return []
    }
}

/**
 * A DESK RUN IS OVER — drop what fed it.
 *
 * The artifact exists, so every conversation that built it is spent. The ones still worth reading are
 * not drafts any more: the thread that authored the artifact was LINKED to it (that is what `tier`
 * distinguishes), and it is reached by editing the artifact, not by resuming a desk. What is left
 * here is scaffolding — the Argus scan that produced a name, the mandate that framed a screen — and
 * leaving it behind meant the hub went on marking the desk as unfinished, and went on holding that
 * agent's other doors shut, over a run the user had finished.
 *
 * DRAFTS ONLY, which is the whole safety of it: a linked thread is untouchable here, so this can
 * never delete the conversation attached to a live setup or book.
 *
 * @returns {Promise<{ok:boolean, deleted:number}>}
 */
async function discardPipelineDrafts({ userId, pipeline }) {
    try {
        if (!pipeline) return { ok: true, deleted: 0 }
        const db = await getDb()
        const r  = await db.collection(COLLECTION).deleteMany(pipelineDraftsQuery(userId, pipeline))
        return { ok: true, deleted: r.deletedCount ?? 0 }
    } catch (err) {
        logger.error(LOG, 'discardPipelineDrafts failed', err)
        return { ok: false, deleted: 0 }
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
    discardPipelineDrafts,
}
