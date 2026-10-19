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
import { newSessionId, isScope, isAgent, toTimelineMessage, sessionTitle, segmentQuery, UNTITLED } from './session.util.js'
import { sessionEvents, silentEvents } from './sessionEvents.js'

const LOG       = '[session]'
const SESSIONS  = 'sessions'
const MESSAGES  = 'session_messages'
const LIST_MAX  = 50
const PAGE_MAX  = 500

// The header a client sees. agentState is the desks' working state — read by the desks (phase 4),
// never shipped to a list row.
const HEADER_PROJECTION = { _id: 0, agentState: 0 }

// `events` is what every change is pushed through (services/sessionEvents.js — the WebSocket). Silent by
// default, so a test or a script pushes nothing; the app's instance below pushes everything.
export function makeSessionService({ getDb = _defaultGetDb, events = silentEvents } = {}) {

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
            // One agent's segment (messagesForAgent): its own rows, and the hand-offs addressed to it.
            await db.collection(MESSAGES).createIndex({ sessionId: 1, agent: 1, seq: 1 })
            await db.collection(MESSAGES).createIndex({ sessionId: 1, to: 1, seq: 1 }, { partialFilterExpression: { kind: 'handoff' } })
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
                    agentState: {}, summaries: {}, seals: {}, links: [], seq: 0,
                    createdAt: now, updatedAt: now, archivedAt: null,
                },
            }, { upsert: true })
        } catch (err) {
            if (err?.code !== 11000) throw err
        }
        return db.collection(SESSIONS).findOne(filter, { projection: HEADER_PROJECTION })
    }

    /**
     * The user's running session in a scope, or null — a READ that never creates one (unlike getActive). A
     * background card lands only in a session the user already has (plan phase 6, H3).
     */
    async function findActive({ userId, scope = 'main' }) {
        if (!isScope(scope)) return null
        const db = await getDb()
        return db.collection(SESSIONS).findOne({ userId: String(userId), scope, status: 'active' }, { projection: HEADER_PROJECTION })
    }

    /**
     * "New session": archive the active one — titled from its first user message — and open a fresh
     * one. An active session with nothing in it is reused rather than archived empty: pressing New
     * twice must not fill the history with blank rows. `force` archives it anyway — a commit ends its session even
     * when the work was built by hand edits alone, with no message in it (act.endAfterCommit, 2026-10-18).
     *
     * NOTHING THE USER SAID → NOT SAVED (Roy, 2026-10-18): a session with no message of theirs would sit in History as
     * "Untitled" — a card pressed and saved, a reopen looked at — and means nothing to keep. It is deleted, not archived.
     * The work it touched keeps its own record (the entity and its sealed context).
     *
     * `discard`: a RESOLVED session — a commit saved its work, and the conversation is on the entity it produced
     * (unified-chat.md §6.2) — is not kept either (Roy, 2026-10-18). History is what ended WITHOUT a save.
     */
    async function startNew({ userId, scope = 'main', force = false, discard = false }) {
        if (!isScope(scope)) return null
        const db  = await getDb()
        const uid = String(userId)
        const current = await db.collection(SESSIONS).findOne({ userId: uid, scope, status: 'active' })
        if (current && (current.seq > 0 || force)) await putAway(db, current, uid, { discard })
        const next = await getActive({ userId, scope })
        // Every open screen moves to the new session together — a phone and a laptop never sit in two.
        if (current && next && current.sessionId !== next.sessionId) events.state(uid, current.sessionId, { archived: true, next: next.sessionId })
        return next
    }

    /**
     * Put the live session away: archived under the title the user's words give it, or deleted outright when it holds
     * nothing worth keeping (`discard` — a commit resolved it — or an "Untitled" one the user said nothing in).
     */
    async function putAway(db, current, uid, { discard = false } = {}) {
        const said  = discard ? [] : await db.collection(MESSAGES)
            .find({ sessionId: current.sessionId, role: 'user' }).sort({ seq: 1 }).limit(20).toArray()
        const title = current.title ?? sessionTitle(said)
        if (discard || title === UNTITLED) {
            await db.collection(MESSAGES).deleteMany({ sessionId: current.sessionId })
            await db.collection(SESSIONS).deleteOne({ sessionId: current.sessionId, userId: uid, status: 'active' })
            return
        }
        const now = Date.now()
        await db.collection(SESSIONS).updateOne(
            { sessionId: current.sessionId, userId: uid, status: 'active' },
            { $set: { status: 'archived', archivedAt: now, updatedAt: now, title } },
        )
    }

    /**
     * Pick an ARCHIVED session back up (History — design §3.5, "opens any archived session read-only, or resumes it";
     * Roy, 2026-10-19). The live one is put away exactly as "New session" puts it away, and this one becomes live again,
     * with its floor and its desks' state as it was left. Already live → returned as is.
     * @returns {Promise<{ session: object } | { reason: 'not_found' }>}
     */
    async function resume({ sessionId, userId }) {
        const db  = await getDb()
        const uid = String(userId)
        const id  = String(sessionId)
        const target = await db.collection(SESSIONS).findOne({ sessionId: id, userId: uid }, { projection: { _id: 0, status: 1, scope: 1 } })
        if (!target) return { reason: 'not_found' }
        const scope = target.scope ?? 'main'
        if (target.status === 'active') return { session: await db.collection(SESSIONS).findOne({ sessionId: id }, { projection: HEADER_PROJECTION }) }

        // Twice at most: a screen that created a fresh live session between the put-away and the switch (getActive
        // upserts) is put away too — the one-live-session index refuses the switch until it is.
        let previous = null
        for (let attempt = 0; attempt < 2; attempt++) {
            const current = await db.collection(SESSIONS).findOne({ userId: uid, scope, status: 'active' })
            if (current) { await putAway(db, current, uid); previous ??= current.sessionId }
            try {
                const now = Date.now()
                const res = await db.collection(SESSIONS).updateOne(
                    { sessionId: id, userId: uid, status: 'archived' },
                    { $set: { status: 'active', archivedAt: null, updatedAt: now } },
                )
                if (!res.matchedCount) return { reason: 'not_found' }   // deleted meanwhile
                break
            } catch (err) {
                if (err?.code !== 11000 || attempt === 1) throw err
            }
        }
        // Every open screen moves to it together, as with "New session".
        if (previous) events.state(uid, previous, { archived: true, next: id })
        return { session: await db.collection(SESSIONS).findOne({ sessionId: id }, { projection: HEADER_PROJECTION }) }
    }

    /**
     * Delete one ARCHIVED session and its rows (History's delete — Roy, 2026-10-18). The live session is not deleted
     * here (`active_session`): "New session" is how it ends. The entities it produced keep their own records.
     * @returns {Promise<{ ok: true } | { reason: 'not_found' | 'active_session' }>}
     */
    async function remove({ sessionId, userId }) {
        const db = await getDb()
        const s  = await db.collection(SESSIONS).findOne({ sessionId: String(sessionId), userId: String(userId) }, { projection: { _id: 0, status: 1 } })
        if (!s) return { reason: 'not_found' }
        if (s.status === 'active') return { reason: 'active_session' }
        await db.collection(MESSAGES).deleteMany({ sessionId: String(sessionId) })
        await db.collection(SESSIONS).deleteOne({ sessionId: String(sessionId), userId: String(userId), status: 'archived' })
        return { ok: true }
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
        const stored = stripId(row)
        events.message(String(userId), String(sessionId), stored)
        return { message: stored }
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

    /**
     * ONE agent's segment after `afterSeq` — its own turns and the hand-offs addressed to it, read with the
     * segment filter (session.util.segmentQuery) instead of paging the whole timeline and discarding the
     * other agents' rows. Pages internally, so no caller writes its own paging loop. Null if not yours.
     */
    async function messagesForAgent({ sessionId, userId, agent, afterSeq = 0 }) {
        return _allAfter({ sessionId, userId, afterSeq, filter: segmentQuery(agent) })
    }

    /** EVERY message after `afterSeq`, in order — a reconnect's replay. Null if the session is not yours. */
    async function allMessagesSince({ sessionId, userId, afterSeq = 0 }) {
        return _allAfter({ sessionId, userId, afterSeq, filter: {} })
    }

    // THE one pager over the timeline: owner-checked, ordered by seq, PAGE_MAX rows a round trip until a short
    // page. Every "all of it" read goes through here — no caller writes its own loop.
    async function _allAfter({ sessionId, userId, afterSeq, filter }) {
        const db = await getDb()
        const owns = await db.collection(SESSIONS).findOne(
            { sessionId: String(sessionId), userId: String(userId) }, { projection: { _id: 0, sessionId: 1 } })
        if (!owns) return null
        const out = []
        let after = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0
        for (;;) {
            const page = await db.collection(MESSAGES)
                .find({ sessionId: String(sessionId), seq: { $gt: after }, ...filter })
                .sort({ seq: 1 }).limit(PAGE_MAX).toArray()
            out.push(...page.map(stripId))
            if (page.length < PAGE_MAX) break
            after = page.at(-1).seq
        }
        return out
    }

    /** Where an agent's last seal ended — its next seal takes only what came after. */
    async function setSealedThrough({ sessionId, userId, agent, seq }) {
        if (!isAgent(agent) || !Number.isFinite(seq)) return { reason: 'invalid' }
        const db = await getDb()
        const r  = await db.collection(SESSIONS).updateOne(
            { sessionId: String(sessionId), userId: String(userId) },
            { $set: { [`seals.${agent}`]: seq } },
        )
        return r.matchedCount ? { ok: true } : { reason: 'not_found' }
    }

    /**
     * Replace one agent's working state (its draft, its scan settings, its half-agreed mandate).
     *
     * Every write bumps the agent's REVISION (`agentRev[agent]`, atomic $inc). A press or a hand edit names the
     * revision it was made on, and one made on a state a turn has since replaced is refused (`stale_state` —
     * services/desks/act.js, plan phase 8a CR D2): Generate pressed on draft v1 must not save v2.
     */
    async function setAgentState({ sessionId, userId, agent, state }) {
        if (!isAgent(agent)) return { reason: 'invalid_agent' }
        const db = await getDb()
        const value = state && typeof state === 'object' ? state : null
        const res = await db.collection(SESSIONS).findOneAndUpdate(
            { sessionId: String(sessionId), userId: String(userId) },
            { $set: { [`agentState.${agent}`]: value, updatedAt: Date.now() }, $inc: { [`agentRev.${agent}`]: 1 } },
            { returnDocument: 'after', projection: { agentRev: 1 } },
        )
        // The driver answers the document (v6) or { value } (v5); the memDb double answers the document.
        const doc = res?.value ?? res
        if (!doc) return { reason: 'not_found' }
        const rev = doc.agentRev?.[agent] ?? 0
        // The side pane draws an agent's surface from this — every open screen redraws together.
        events.state(String(userId), String(sessionId), { agent, state: value, rev })
        return { ok: true, rev }
    }

    /**
     * Remove timeline rows by seq — sealing moves an agent's turns OUT of the session onto the entity they
     * produced (§6.2). Owner-checked first; the seqs are only ever this session's.
     */
    async function removeMessages({ sessionId, userId, seqs }) {
        if (!Array.isArray(seqs) || !seqs.length) return { removed: 0 }
        const db = await getDb()
        const owns = await db.collection(SESSIONS).findOne(
            { sessionId: String(sessionId), userId: String(userId) }, { projection: { _id: 0, sessionId: 1 } })
        if (!owns) return { reason: 'not_found' }
        const r = await db.collection(MESSAGES).deleteMany({ sessionId: String(sessionId), seq: { $in: seqs } })
        events.removed(String(userId), String(sessionId), seqs)
        return { removed: r.deletedCount ?? 0 }
    }

    /**
     * The chain running in this session (plan phase 5c): `{ id, status, origin, steps, next, queue,
     * awaiting, pauseRequested }`, or null. Written BEFORE each step, so a restart finds it.
     */
    async function setChain({ sessionId, userId, chain }) {
        const db = await getDb()
        const r  = await db.collection(SESSIONS).updateOne(
            { sessionId: String(sessionId), userId: String(userId) },
            { $set: { chain: chain && typeof chain === 'object' ? chain : null, updatedAt: Date.now() } },
        )
        if (!r.matchedCount) return { reason: 'not_found' }
        events.state(String(userId), String(sessionId), { chain: chain ? { id: chain.id, status: chain.status, awaiting: chain.awaiting ?? null } : null })
        return { ok: true }
    }

    /** Every session whose chain was RUNNING — what the boot sweep pauses after a restart. */
    async function findRunningChains() {
        const db = await getDb()
        return db.collection(SESSIONS)
            .find({ 'chain.status': 'running' }, { projection: { _id: 0, sessionId: 1, userId: 1, floor: 1, chain: 1 } })
            .toArray()
    }

    /** Who has the floor — the agent the user's next message goes to (unified-chat.md §3.3). */
    async function setFloor({ sessionId, userId, agent }) {
        if (!isAgent(agent)) return { reason: 'invalid_agent' }
        const db = await getDb()
        const r  = await db.collection(SESSIONS).updateOne(
            { sessionId: String(sessionId), userId: String(userId) },
            { $set: { floor: agent, updatedAt: Date.now() } },
        )
        if (!r.matchedCount) return { reason: 'not_found' }
        events.state(String(userId), String(sessionId), { floor: agent })
        return { ok: true }
    }

    /**
     * One agent's rolling summary: `{ text, throughSeq }` — its segment up to throughSeq lives in the text.
     * NEWER ONLY: a summary that covers no further than the stored one is dropped. A slow background fold
     * must never overwrite a newer fold — or the reset a seal just wrote, which would bring sealed work
     * back as the live summary.
     */
    async function setSummary({ sessionId, userId, agent, summary }) {
        if (!isAgent(agent)) return { reason: 'invalid_agent' }
        if (!summary || typeof summary.text !== 'string' || !Number.isFinite(summary.throughSeq)) return { reason: 'invalid_summary' }
        const db  = await getDb()
        const key = `summaries.${agent}`
        // The "newer only" condition is IN the update's filter, so it is atomic: a check-then-write could let a
        // seal's reset land between the two and then be overwritten by the slower fold.
        const r = await db.collection(SESSIONS).updateOne(
            { sessionId: String(sessionId), userId: String(userId),
              $or: [{ [`${key}.throughSeq`]: { $lt: summary.throughSeq } }, { [key]: { $exists: false } }] },
            { $set: { [key]: { text: summary.text, throughSeq: summary.throughSeq } } },
        )
        if (r.matchedCount) return { ok: true }
        // Nothing matched: the session is not this user's, or the stored summary already reaches as far.
        const owns = await db.collection(SESSIONS).findOne({ sessionId: String(sessionId), userId: String(userId) }, { projection: { _id: 0, sessionId: 1 } })
        return { reason: owns ? 'stale' : 'not_found' }
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

    return { ensureIndexes, getActive, findActive, startNew, resume, list, remove, get, append, messagesSince, messagesForAgent, allMessagesSince, removeMessages, setAgentState, setSealedThrough, setChain, findRunningChains, setFloor, setSummary, addLink }
}

export const sessionService = makeSessionService({ events: sessionEvents })
