// ── Unified chat, phase 9: the legacy chat stores move onto the new model ─────────────────────────────────────
// docs/design/unified-chat-plan.md §11, design decision 12, Roy 2026-10-20.
//
//   threads linked to a setup / coverage / scan / book → that entity's agent_context (importLegacy), row deleted
//   threads linked to an entity that is GONE           → deleted (nothing to attach to), counted
//   threads of the retired desks (Kairos `call`, the Idea agent, Pythia's old `tilt`) → deleted (Roy: delete them)
//   draft threads of the chat desks (no entity)         → one ARCHIVED session each (importArchived), row deleted
//   Pythia's and Aether's own threads                   → UNTOUCHED: their panels still keep their chats there
//   setups' chat_state.messages                         → the setup's Mentor context; only `messages` is unset —
//                                                         `draft` / `coverage` are Mentor's live worksheet state
//   scans.chat                                          → the scan's Argus context; unset
//   portfolio_books.messages                            → the book's Atlas context; unset (the book itself stays)
//   chat_state on idea entities and the old `ideas` copy → unset (the retired Idea agent's transcripts)
//
import { ENTITIES, LEGACY_IDEAS } from '../entity/entityCollection.js'
import { COLLECTION as COVERAGE } from '../../api/analyst/coverage.service.js'
import { COLLECTION as SCANS } from '../../api/scanner/scan.service.js'
import { COLLECTION as BOOKS } from '../../api/portfolio/portfolioChat.service.js'
import { COLLECTION as THREADS } from '../thread.service.js'
import { COLLECTION as CONTEXTS } from '../agentContext.service.js'
import { SESSIONS, MESSAGES } from '../session.service.js'

// Idempotent: every import records its source and is skipped on a re-run; sources are removed only after their
// import is written. Dry run unless `apply`. The `call` kind keeps its chat_state (CLAUDE.md — kept data).

// A linked thread's subject → the context it becomes. The retired kinds are absent on purpose: they are deleted.
export const SUBJECTS = Object.freeze({
    setup:     { kind: 'setup',     agent: 'mentor',    coll: ENTITIES, idField: 'id', filter: { kind: 'setup' } },
    coverage:  { kind: 'coverage',  agent: 'analyst',   coll: COVERAGE, idField: 'id' },
    scan:      { kind: 'scan',      agent: 'scanner',   coll: SCANS,    idField: 'id' },
    portfolio: { kind: 'portfolio', agent: 'portfolio', coll: BOOKS,    idField: 'portfolioId' },
})
// The desks whose drafts become archived sessions — the unified chat's agents.
const CHAT_DESKS = new Set(['axl', 'mentor', 'analyst', 'scanner', 'portfolio'])
// Their own chats still live in `threads` (phase 8e, decision D1).
const OWN_CHAT_DESKS = new Set(['strategy', 'aether'])

/**
 * What happens to one thread. Pure. `exists(subjectType, subjectId)` says whether its entity is still there.
 * → { action: 'context', kind, agent, entityId } | { action: 'session' } | { action: 'delete', why } | { action: 'keep' }
 */
export function planThread(t, exists) {
    const agent = t?.agent
    const linked = t?.tier === 'linked' && t?.subjectId
    if (OWN_CHAT_DESKS.has(agent) && t?.subjectType !== 'tilt') return { action: 'keep' }
    if (linked) {
        const subj = SUBJECTS[t.subjectType]
        if (!subj) return { action: 'delete', why: `retired:${t.subjectType}` }
        if (!exists(t.subjectType, t.subjectId)) return { action: 'delete', why: 'entity_gone' }
        return { action: 'context', kind: subj.kind, agent: subj.agent, entityId: String(t.subjectId) }
    }
    if (CHAT_DESKS.has(agent)) return { action: 'session' }
    return { action: 'delete', why: `retired:${agent ?? 'unknown'}` }
}

// The old panels saved their error placeholder as an assistant turn ("Streaming failed"). It is not the agent's words,
// and the agent rereads this history when the item is reopened — so it does not move.
const PLACEHOLDERS = new Set(['Streaming failed'])
const msgs = (v) => (Array.isArray(v) ? v : []).filter(m => !(m?.role === 'assistant' && PLACEHOLDERS.has(String(m?.content ?? '').trim())))
const tally = (r, k) => { r[k] = (r[k] ?? 0) + 1 }

async function sizeMb(db) {
    const s = await db.stats()
    return { data: +(s.dataSize / 1e6).toFixed(1), storage: +(s.storageSize / 1e6).toFixed(1), index: +(s.indexSize / 1e6).toFixed(1) }
}

/**
 * Every document this migration may change or delete, whole — what a restore needs (Roy, 2026-10-20: back up before
 * anything is deleted). Pythia's and Aether's own threads are left out: nothing touches them. The existing
 * agent_contexts are in it too: an import rewrites the context it lands on.
 */
export async function snapshotAffected(db) {
    const names = new Set((await db.listCollections().toArray()).map(c => c.name))
    const read = (coll, q) => (names.has(coll) ? db.collection(coll).find(q).toArray() : [])
    const threads = (await read(THREADS, {})).filter(t => planThread(t, () => true).action !== 'keep')
    return {
        takenAt: new Date().toISOString(), db: db.databaseName,
        [THREADS]:        threads,
        [`${ENTITIES}:setup.chat_state`]: await read(ENTITIES, { kind: 'setup', 'chat_state.messages': { $exists: true } }),
        [`${ENTITIES}:idea.chat_state`]:  await read(ENTITIES, { kind: 'idea', chat_state: { $exists: true } }),
        [`${SCANS}.chat`]:      await read(SCANS, { chat: { $exists: true } }),
        [`${BOOKS}.messages`]:  await read(BOOKS, { messages: { $exists: true } }),
        [`${LEGACY_IDEAS}.chat_state`]: await read(LEGACY_IDEAS, { chat_state: { $exists: true } }),
        [CONTEXTS]: await read(CONTEXTS, {}),
    }
}

/**
 * Undo an applied run from its snapshot: the deleted threads come back, the unset fields are set again, the contexts
 * go back to what they were (a context the run CREATED — it carries `legacy` and was not in the snapshot — is removed),
 * and the archived sessions it filed (`legacySource`) are deleted with their rows. → counts.
 */
export async function restoreUnifiedChat({ db, snapshot }) {
    const out = { threads: 0, fields: 0, contexts: 0, contextsRemoved: 0, sessionsRemoved: 0 }
    for (const t of snapshot[THREADS] ?? []) { await db.collection(THREADS).replaceOne({ threadId: t.threadId }, t, { upsert: true }); out.threads++ }
    const setBack = async (coll, rows, keyOf, field, valueOf) => {
        for (const r of rows ?? []) { await db.collection(coll).updateOne(keyOf(r), { $set: { [field]: valueOf(r) } }); out.fields++ }
    }
    await setBack(ENTITIES, snapshot[`${ENTITIES}:setup.chat_state`], r => ({ id: r.id, kind: 'setup' }), 'chat_state.messages', r => r.chat_state?.messages ?? [])
    await setBack(ENTITIES, snapshot[`${ENTITIES}:idea.chat_state`], r => ({ id: r.id, kind: 'idea' }), 'chat_state', r => r.chat_state ?? null)
    await setBack(SCANS, snapshot[`${SCANS}.chat`], r => ({ id: r.id }), 'chat', r => r.chat ?? [])
    await setBack(BOOKS, snapshot[`${BOOKS}.messages`], r => ({ portfolioId: r.portfolioId, userId: r.userId }), 'messages', r => r.messages ?? [])
    await setBack(LEGACY_IDEAS, snapshot[`${LEGACY_IDEAS}.chat_state`], r => ({ id: r.id }), 'chat_state', r => r.chat_state ?? null)
    const ctxKey = (c) => ({ userId: c.userId, kind: c.kind, entityId: c.entityId, agent: c.agent })
    const had = new Set((snapshot[CONTEXTS] ?? []).map(c => JSON.stringify(ctxKey(c))))
    for (const c of await db.collection(CONTEXTS).find({ legacy: { $exists: true } }).toArray()) {
        if (!had.has(JSON.stringify(ctxKey(c)))) { await db.collection(CONTEXTS).deleteOne(ctxKey(c)); out.contextsRemoved++ }
    }
    for (const c of snapshot[CONTEXTS] ?? []) { await db.collection(CONTEXTS).replaceOne(ctxKey(c), c, { upsert: true }); out.contexts++ }
    for (const s of await db.collection(SESSIONS).find({ legacySource: { $exists: true } }).toArray()) {
        await db.collection(MESSAGES).deleteMany({ sessionId: s.sessionId })
        await db.collection(SESSIONS).deleteOne({ sessionId: s.sessionId })
        out.sessionsRemoved++
    }
    return out
}

/**
 * Run (or, without `apply`, rehearse) the migration on one database. `contexts` / `sessions` are services bound to
 * the SAME database. `backup(snapshot)` is called before the first write and must resolve, or nothing is written.
 * → a report: what was (or would be) moved, filed, deleted and unset, and the size before/after.
 */
export async function migrateUnifiedChat({ db, contexts, sessions, apply = false, backup = null, log = () => {} }) {
    const names = new Set((await db.listCollections().toArray()).map(c => c.name))
    // Prod's Atlas chats are still in `portfolio_chats` until scripts/rename-portfolio-books.mjs runs (phase 3).
    if (names.has('portfolio_chats') && await db.collection('portfolio_chats').countDocuments() > 0) {
        return { refused: 'portfolio_chats still holds the books — run scripts/rename-portfolio-books.mjs first' }
    }
    const report = { apply, db: db.databaseName, before: await sizeMb(db), threads: {}, contexts: 0, sessions: 0, skipped: {}, unset: {} }
    // No write without a backup in hand: a failed or missing backup stops the run here.
    if (apply) {
        if (typeof backup !== 'function') return { refused: 'no backup step — pass one, the deletes cannot be undone without it' }
        report.backup = await backup(await snapshotAffected(db))
    }

    // The entities a thread may point at, read once per kind.
    const ids = {}
    for (const [type, s] of Object.entries(SUBJECTS)) {
        ids[type] = names.has(s.coll)
            ? new Set((await db.collection(s.coll).find(s.filter ?? {}, { projection: { _id: 0, [s.idField]: 1 } }).toArray()).map(d => String(d[s.idField])))
            : new Set()
    }
    const exists = (type, id) => ids[type]?.has(String(id)) ?? false
    // An import that did not write is fine to clear its source for only when there was nothing to keep, or it is already in.
    const imported = async (res, source) => {
        if (res.imported) return true
        tally(report.skipped, res.reason ?? 'skipped')
        log(`skip ${source}: ${res.reason}`)
        return res.reason === 'already_imported' || res.reason === 'no_messages' || res.reason === 'nothing_said'
    }

    // ── threads ──
    if (names.has(THREADS)) {
        for (const t of await db.collection(THREADS).find({}).toArray()) {
            const plan = planThread(t, exists)
            tally(report.threads, plan.action === 'delete' ? `delete:${plan.why}` : plan.action)
            if (!apply || plan.action === 'keep') continue
            const source = `thread:${t.threadId}`
            let done = plan.action === 'delete'
            if (plan.action === 'context') {
                const res = await contexts.importLegacy({ userId: t.userId, kind: plan.kind, entityId: plan.entityId, agent: plan.agent, messages: msgs(t.messages), source, at: t.updatedAt ?? t.createdAt })
                if (res.imported) report.contexts++
                done = await imported(res, source)
            } else if (plan.action === 'session') {
                const at = Number.isFinite(t.createdAt) ? t.createdAt : null
                const res = await sessions.importArchived({
                    userId: t.userId, title: t.title ?? null, source, createdAt: at, archivedAt: t.updatedAt ?? at,
                    messages: msgs(t.messages).map(m => ({ agent: CHAT_DESKS.has(t.agent) ? t.agent : 'axl', role: m.role, content: m.content, at })),
                })
                if (res.imported) report.sessions++
                done = await imported(res, source)
            }
            // The row goes only once what it held is somewhere else (or is meant to go).
            if (done) await db.collection(THREADS).deleteOne({ threadId: t.threadId })
        }
    }

    // ── a setup's old transcript (its draft / coverage stay — Mentor's live worksheet) ──
    const setups = await db.collection(ENTITIES).find({ kind: 'setup', 'chat_state.messages': { $exists: true } }, { projection: { _id: 0, id: 1, userId: 1, savedAt: 1, 'chat_state.messages': 1 } }).toArray()
    report.unset['setup chat_state.messages'] = setups.length
    for (const s of apply ? setups : []) {
        const source = `setup:${s.id}`
        const res = await contexts.importLegacy({ userId: s.userId, kind: 'setup', entityId: s.id, agent: 'mentor', messages: msgs(s.chat_state?.messages), source, at: s.savedAt })
        if (res.imported) report.contexts++
        if (await imported(res, source)) await db.collection(ENTITIES).updateOne({ id: s.id, kind: 'setup' }, { $unset: { 'chat_state.messages': '' } })
    }

    // ── a scan's chat ──
    const scans = names.has(SCANS) ? await db.collection(SCANS).find({ chat: { $exists: true } }, { projection: { _id: 0, id: 1, userId: 1, savedAt: 1, chat: 1 } }).toArray() : []
    report.unset['scans.chat'] = scans.length
    for (const s of apply ? scans : []) {
        const source = `scan:${s.id}`
        const res = await contexts.importLegacy({ userId: s.userId, kind: 'scan', entityId: s.id, agent: 'scanner', messages: msgs(s.chat), source, at: s.savedAt })
        if (res.imported) report.contexts++
        if (await imported(res, source)) await db.collection(SCANS).updateOne({ id: s.id }, { $unset: { chat: '' } })
    }

    // ── a book's chat (the book — mandate, thesis, reviews, Themis — stays) ──
    const books = names.has(BOOKS) ? await db.collection(BOOKS).find({ messages: { $exists: true } }, { projection: { _id: 0, portfolioId: 1, userId: 1, savedAt: 1, messages: 1 } }).toArray() : []
    report.unset['portfolio_books.messages'] = books.length
    for (const b of apply ? books : []) {
        const source = `book:${b.portfolioId}`
        const res = await contexts.importLegacy({ userId: b.userId, kind: 'portfolio', entityId: b.portfolioId, agent: 'portfolio', messages: msgs(b.messages), source, at: b.savedAt })
        if (res.imported) report.contexts++
        if (await imported(res, source)) await db.collection(BOOKS).updateOne({ portfolioId: b.portfolioId, userId: b.userId }, { $unset: { messages: '' } })
    }

    // ── the retired Idea agent's transcripts: on idea entities, and on the old `ideas` copy ──
    const ideaQ = { kind: 'idea', chat_state: { $exists: true } }
    report.unset['idea chat_state'] = await db.collection(ENTITIES).countDocuments(ideaQ)
    report.unset['ideas.chat_state (old copy)'] = names.has(LEGACY_IDEAS) ? await db.collection(LEGACY_IDEAS).countDocuments({ chat_state: { $exists: true } }) : 0
    if (apply) {
        await db.collection(ENTITIES).updateMany(ideaQ, { $unset: { chat_state: '' } })
        if (names.has(LEGACY_IDEAS)) await db.collection(LEGACY_IDEAS).updateMany({ chat_state: { $exists: true } }, { $unset: { chat_state: '' } })
    }

    report.after = await sizeMb(db)
    return report
}
