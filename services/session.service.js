// The unified chat's session store (docs/design/unified-chat.md §3.5, plan phase 3 — §5.1).
//
//   sessions          one header per session: { sessionId, userId, scope, status, title, summary, floor,
//                     agentState, summaries, links, seq, createdAt, updatedAt, archivedAt }
//   session_messages  one row per timeline message: { sessionId, seq, agent, role, kind, content, ref, to, at }
//
// ONE active session per user per scope — 'main' (the one chat) and 'strategy' / 'aether' (the admin
// desks' own panels, decision 16). "New session" archives the active one; history lists them. Nothing
// expires and there is no cap: a session is the record of what was said, and work that produced an
// entity leaves the session for that entity's sealed context (agentContext.service).
//
// The timeline is ROWS, not an array on the header (plan D3): an endless chat as one array grows toward
// Mongo's 16 MB document limit and rewrites itself on every turn; as rows a turn is one insert and a
// reconnect's replay is one `seq > n` read.
//
// Every read and write is owner-scoped by userId: another user's sessionId answers nothing.
//
// Built as a factory over `getDb` so the tests run it on tests/helpers/memDb.js.

import { getDb as _defaultGetDb, stripId } from '../providers/mongodb.provider.js'
import { logger } from './logger.service.js'
import { newSessionId, isScope, isAgent, toTimelineMessage, sessionTitle } from './session.util.js'

const LOG       = '[session]'
const SESSIONS  = 'sessions'
const MESSAGES  = 'session_messages'
const LIST_MAX  = 50
const PAGE_MAX  = 500

// The header a client sees. agentState is the desks' working state — read by the desks (phase 4),
// never shipped to a list row.
const HEADER_PROJECTION = { _id: 0, agentState: 0 }

export function makeSessionService({ getDb = _defaultGetDb } = {}) {

    async function ensureIndexes() {
        try {
            const db = await getDb()
            await db.collection(SESSIONS).createIndex({ sessionId: 1 }, { unique: true })
            // THE "one active per user per scope" backstop. The service never creates a second one
            // (getActive upserts on exactly this filter); the index is what holds under a race.
            await db.collection(SESSIONS).createIndex(
                { userId: 1, scope: 1, status: 1 },
                { unique: true, partialFilterExpression: { status: 'active' } },
            )
            await db.collection(SESSIONS).createIndex({ userId: 1, scope: 1, updatedAt: -1 })
            await db.collection(MESSAGES).createIndex({ sessionId: 1, seq: 1 }, { unique: true })
        } catch (err) {
            logger.warn(LOG, 'ensureIndexes failed', err.message)
        }
    }

    /**
     * The user's running session in this scope — created on first ask, so a caller never has to check.
     * A duplicate-key error is two first-asks racing: the other one won, so read it.
     */
    async function getActive({ userId, scope = 'main' }) {
        if (!isScope(scope)) return null
        const db  = await getDb()
        const uid = String(userId)
        const now = Date.now()
        const filter = { userId: uid, scope, status: 'active' }
        try {
            await db.collection(SESSIONS).updateOne(filter, {
                $setOnInsert: {
                    sessionId: newSessionId(), title: null, summary: null, floor: 'axl',
                    agentState: {}, summaries: {}, links: [], seq: 0,
                    createdAt: now, updatedAt: now, archivedAt: null,
                },
            }, { upsert: true })
        } catch (err) {
            if (err?.code !== 11000) throw err
        }
        return db.collection(SESSIONS).findOne(filter, { projection: HEADER_PROJECTION })
    }

    /**
     * "New session": archive the active one — titled from its first user message — and open a fresh
     * one. An active session with nothing in it is reused rather than archived empty: pressing New
     * twice must not fill the history with blank rows.
     */
    async function startNew({ userId, scope = 'main' }) {
        if (!isScope(scope)) return null
        const db  = await getDb()
        const uid = String(userId)
        const current = await db.collection(SESSIONS).findOne({ userId: uid, scope, status: 'active' })
        if (current && current.seq > 0) {
            const firstPage = await db.collection(MESSAGES)
                .find({ sessionId: current.sessionId }).sort({ seq: 1 }).limit(20).toArray()
            const now = Date.now()
            await db.collection(SESSIONS).updateOne(
                { sessionId: current.sessionId, userId: uid, status: 'active' },
                { $set: { status: 'archived', archivedAt: now, updatedAt: now, title: current.title ?? sessionTitle(firstPage) } },
            )
        }
        return getActive({ userId, scope })
    }

    /** History: the user's sessions in a scope, newest first, headers only. */
    async function list({ userId, scope = 'main' }) {
        if (!isScope(scope)) return []
        const db = await getDb()
        return db.collection(SESSIONS)
            .find({ userId: String(userId), scope }, { projection: HEADER_PROJECTION })
            .sort({ updatedAt: -1 }).limit(LIST_MAX).toArray()
    }

    /** One session's header, owner-scoped. agentState included — this is the desks' read. */
    async function get({ sessionId, userId }) {
        const db  = await getDb()
        const doc = await db.collection(SESSIONS).findOne({ sessionId: String(sessionId), userId: String(userId) })
        return doc ? stripId(doc) : null
    }

    /**
     * Append one message to an ACTIVE session. The seq is claimed atomically on the header
     * (findOneAndUpdate $inc), so two writers can never take the same number — the unique
     * {sessionId, seq} index would refuse it anyway. An archived session is read-only: `{ reason }`.
     */
    async function append({ sessionId, userId, message }) {
        const parsed = toTimelineMessage(message)
        if (parsed.error) return { reason: 'invalid_message', error: parsed.error }
        const db  = await getDb()
        const now = parsed.message.at
        const res = await db.collection(SESSIONS).findOneAndUpdate(
            { sessionId: String(sessionId), userId: String(userId), status: 'active' },
            { $inc: { seq: 1 }, $set: { updatedAt: now } },
            { returnDocument: 'after', projection: { seq: 1 } },
        )
        // The driver answers the document (v6) or { value } (v5); the memDb double answers the document.
        const seq = (res?.value ?? res)?.seq
        if (!Number.isFinite(seq)) return { reason: 'not_found' }
        const row = { sessionId: String(sessionId), seq, ...parsed.message }
        await db.collection(MESSAGES).insertOne(row)
        return { message: stripId(row) }
    }

    /** The messages after `afterSeq`, in order — the reconnect replay and the page read. */
    async function messagesSince({ sessionId, userId, afterSeq = 0, limit = PAGE_MAX }) {
        const db = await getDb()
        const owns = await db.collection(SESSIONS).findOne(
            { sessionId: String(sessionId), userId: String(userId) }, { projection: { _id: 0, sessionId: 1 } })
        if (!owns) return null
        const after = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0
        const n     = Math.min(Math.max(Number(limit) || PAGE_MAX, 1), PAGE_MAX)
        const rows  = await db.collection(MESSAGES)
            .find({ sessionId: String(sessionId), seq: { $gt: after } }).sort({ seq: 1 }).limit(n).toArray()
        return rows.map(stripId)
    }

    /** Replace one agent's working state (its draft, its scan settings, its half-agreed mandate). */
    async function setAgentState({ sessionId, userId, agent, state }) {
        if (!isAgent(agent)) return { reason: 'invalid_agent' }
        const db = await getDb()
        const r  = await db.collection(SESSIONS).updateOne(
            { sessionId: String(sessionId), userId: String(userId) },
            { $set: { [`agentState.${agent}`]: state && typeof state === 'object' ? state : null, updatedAt: Date.now() } },
        )
        return r.matchedCount ? { ok: true } : { reason: 'not_found' }
    }

    /** Record an entity this session produced — a session links to many (decision 5). */
    async function addLink({ sessionId, userId, link }) {
        const { kind, id, agent } = link ?? {}
        if (!kind || !id || !isAgent(agent)) return { reason: 'invalid_link' }
        const db = await getDb()
        const r  = await db.collection(SESSIONS).updateOne(
            { sessionId: String(sessionId), userId: String(userId) },
            { $push: { links: { kind: String(kind), id: String(id), agent, at: Date.now() } }, $set: { updatedAt: Date.now() } },
        )
        return r.matchedCount ? { ok: true } : { reason: 'not_found' }
    }

    return { ensureIndexes, getActive, startNew, list, get, append, messagesSince, setAgentState, addLink }
}

export const sessionService = makeSessionService()
