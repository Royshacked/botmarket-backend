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
// How recent a session message means the app is live (see migrateUnifiedChat).
const LIVE_WINDOW_MS = 10 * 60_000
// A source's owner as a string — or null, never "undefined": an ownerless source must fail the owner check.
const _owner = (u) => (u === null || u === undefined || u === '' ? null : String(u))
const msgs = (v) => (Array.isArray(v) ? v : []).filter(m => !(m?.role === 'assistant' && PLACEHOLDERS.has(String(m?.content ?? '').trim())))
const tally = (r, k) => { r[k] = (r[k] ?? 0) + 1 }

/**
 * The part of a thread that is about ITS company. An old panel thread could go on to a second name — revise ZTS, then
 * REGN, in one Prometheus thread — and was linked to whichever item it produced last (axl_dev 2026-10-20: REGN's
 * history opened on a ZTS revision, ABBV's on three WPM asks). For an entity of one company (coverage `cov_SYM_…`, a
 * setup `setup_SYM_…`) the thread is kept from the first USER turn that names that symbol; one that never names it is
 * kept whole — there is nothing to cut on. Pure. → the messages to move.
 */
export function subjectSlice(messages, entityId) {
    const sym = (String(entityId ?? '').match(/^(?:cov|setup)_([A-Z0-9.-]+)_/) || [])[1]
    const list = Array.isArray(messages) ? messages : []
    if (!sym) return list
    const named = new RegExp(`(^|[^A-Za-z0-9])\\$?${sym.replace(/[.-]/g, '\\$&')}([^A-Za-z0-9]|$)`)
    const first = list.findIndex(m => m?.role === 'user' && named.test(String(m?.content ?? '')))
    return first > 0 ? list.slice(first) : list
}

/**
 * ONE entity's legacy sources → one history, oldest first. A source whose whole conversation already appears (in order)
 * inside a source taken before it is a COPY — a book's thread and the book's own `messages` were the same chat (217
 * repeated turns on axl_dev) — and is left out; one that EXTENDS what is taken replaces it; anything else is a separate
 * conversation and follows in time order. Compared by role + words. Pure. → { messages, at, dropped }
 */
export function mergeSources(sources) {
    const sig = (m) => `${m.role}\u0000${String(m.content ?? '').trim()}`
    const contains = (outer, inner) => {
        if (!inner.length) return true
        // Separators at BOTH ends, so only whole messages match — "yes" is not a copy of "yes please, go".
        const a = `\u0001${outer.map(sig).join('\u0001')}\u0001`, b = `\u0001${inner.map(sig).join('\u0001')}\u0001`
        return a.includes(b)
    }
    const ordered = [...(sources ?? [])].sort((x, y) => (Number(x.at) || 0) - (Number(y.at) || 0))
    const taken = []   // separate conversations, each a list of messages
    let dropped = 0
    for (const s of ordered) {
        const list = (s.messages ?? []).filter(m => m && typeof m.content === 'string' && m.content.trim())
        if (!list.length) continue
        if (taken.some(t => contains(t, list))) { dropped++; continue }
        const i = taken.findIndex(t => contains(list, t))
        if (i >= 0) { taken[i] = list; dropped++ } else taken.push(list)
    }
    const first = ordered.find(s => (s.messages ?? []).length)
    return { messages: taken.flat(), at: Number(first?.at) || null, dropped }
}

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
    // A context the run touched loses exactly the legacy messages the run put in FRONT (`legacyAdded` minus what it held
    // before) — anything sealed onto it SINCE stays. One the run created and nothing sealed onto since is removed.
    const before = new Map((snapshot[CONTEXTS] ?? []).map(c => [JSON.stringify(ctxKey(c)), c]))
    for (const c of await db.collection(CONTEXTS).find({ legacy: { $exists: true } }).toArray()) {
        const was  = before.get(JSON.stringify(ctxKey(c)))
        // A run from BEFORE the count was recorded: there is no telling its messages apart, so the context goes back
        // whole — as it was in the snapshot, or gone if the run created it.
        if (c.legacyAdded === undefined) {
            if (was) await db.collection(CONTEXTS).replaceOne(ctxKey(c), was)
            else await db.collection(CONTEXTS).deleteOne(ctxKey(c))
            out[was ? 'contexts' : 'contextsRemoved']++
            continue
        }
        const cut  = Math.max(0, (c.legacyAdded ?? 0) - (was?.legacyAdded ?? 0))
        const kept = (c.messages ?? []).slice(cut)
        if (!was && !kept.length) { await db.collection(CONTEXTS).deleteOne(ctxKey(c)); out.contextsRemoved++; continue }
        // Nothing sealed since → exactly what it was, to the timestamp.
        if (was && kept.length === (was.messages ?? []).length) { await db.collection(CONTEXTS).replaceOne(ctxKey(c), was); out.contexts++; continue }
        const back = { ...c, messages: kept }
        if (was?.legacy) back.legacy = was.legacy; else delete back.legacy
        if (was?.legacyAdded) back.legacyAdded = was.legacyAdded; else delete back.legacyAdded
        await db.collection(CONTEXTS).replaceOne(ctxKey(c), back)
        out.contexts++
    }
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
export async function migrateUnifiedChat({ db, contexts, sessions, apply = false, backup = null, liveOk = false, log = () => {} }) {
    const names = new Set((await db.listCollections().toArray()).map(c => c.name))
    // Prod's Atlas chats are still in `portfolio_chats` until scripts/rename-portfolio-books.mjs runs (phase 3).
    if (names.has('portfolio_chats') && await db.collection('portfolio_chats').countDocuments() > 0) {
        return { refused: 'portfolio_chats still holds the books — run scripts/rename-portfolio-books.mjs first' }
    }
    // NOT WHILE THE APP IS IN USE. An import reads a context and replaces it; a user's chat sealing onto the same item
    // in between would be lost. Only the unified-chat code writes session messages, so a recent one means it is live
    // and taking turns — on prod the migration runs before it does (the runbook). `liveOk` is the said-out-loud override.
    if (apply && !liveOk && names.has(MESSAGES)) {
        const recent = await db.collection(MESSAGES).countDocuments({ at: { $gt: Date.now() - LIVE_WINDOW_MS } })
        if (recent) return { refused: `${recent} session message(s) in the last ${LIVE_WINDOW_MS / 60000} minutes — the app is in use; stop it (or pass --live-ok)` }
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
    // An import that did not write is fine to clear its sources for only when there was nothing to keep, or it is in.
    const settled = (res, label) => {
        if (res.imported) return true
        tally(report.skipped, res.reason ?? 'skipped')
        log(`skip ${label}: ${res.reason}`)
        // One with no owner (no userId) can never be shown to anyone — it goes like the other dead sources (the backup has it).
        if (res.reason === 'userId and entityId are required' || res.reason === 'invalid') { tally(report.skipped, 'no_owner_dropped'); return true }
        return res.reason === 'already_imported' || res.reason === 'no_messages' || res.reason === 'nothing_said'
    }

    // ── 1. Gather every legacy conversation, by the context it becomes ──
    // One entity's history can sit in several places (its linked threads AND its own field), so each context is
    // built from ALL its sources at once, in time order (mergeSources) — not one import per source.
    const groups = new Map()   // context key → { key, sources: [{ source, at, messages, clear }] }
    const add = (key, src) => {
        const k = `${key.userId}|${key.kind}|${key.entityId}|${key.agent}`
        if (!groups.has(k)) groups.set(k, { key, sources: [] })
        groups.get(k).sources.push(src)
    }
    const threadDeletes = []   // threads to drop outright (retired desks, entities gone)
    const drafts = []          // threads that become archived sessions
    if (names.has(THREADS)) {
        for (const t of await db.collection(THREADS).find({}).toArray()) {
            const plan = planThread(t, exists)
            tally(report.threads, plan.action === 'delete' ? `delete:${plan.why}` : plan.action)
            if (plan.action === 'delete') threadDeletes.push(t.threadId)
            else if (plan.action === 'session') drafts.push(t)
            else if (plan.action === 'context') {
                add({ userId: _owner(t.userId), kind: plan.kind, entityId: plan.entityId, agent: plan.agent }, {
                    source: `thread:${t.threadId}`, at: t.updatedAt ?? t.createdAt ?? 0,
                    messages: subjectSlice(msgs(t.messages), plan.entityId),
                    clear: () => db.collection(THREADS).deleteOne({ threadId: t.threadId }),
                })
            }
        }
    }
    // A setup's old transcript (its draft / coverage stay — Mentor's live worksheet).
    const setups = await db.collection(ENTITIES).find({ kind: 'setup', 'chat_state.messages': { $exists: true } }, { projection: { _id: 0, id: 1, userId: 1, savedAt: 1, 'chat_state.messages': 1 } }).toArray()
    report.unset['setup chat_state.messages'] = setups.length
    for (const s of setups) add({ userId: _owner(s.userId), kind: 'setup', entityId: s.id, agent: 'mentor' }, {
        source: `setup:${s.id}`, at: s.savedAt ?? 0, messages: msgs(s.chat_state?.messages),
        clear: () => db.collection(ENTITIES).updateOne({ id: s.id, kind: 'setup' }, { $unset: { 'chat_state.messages': '' } }),
    })
    // A scan's chat.
    const scans = names.has(SCANS) ? await db.collection(SCANS).find({ chat: { $exists: true } }, { projection: { _id: 0, id: 1, userId: 1, savedAt: 1, chat: 1 } }).toArray() : []
    report.unset['scans.chat'] = scans.length
    for (const s of scans) add({ userId: _owner(s.userId), kind: 'scan', entityId: s.id, agent: 'scanner' }, {
        source: `scan:${s.id}`, at: s.savedAt ?? 0, messages: msgs(s.chat),
        clear: () => db.collection(SCANS).updateOne({ id: s.id }, { $unset: { chat: '' } }),
    })
    // A book's chat (the book — mandate, thesis, reviews, Themis — stays).
    const books = names.has(BOOKS) ? await db.collection(BOOKS).find({ messages: { $exists: true } }, { projection: { _id: 0, portfolioId: 1, userId: 1, savedAt: 1, messages: 1 } }).toArray() : []
    report.unset['portfolio_books.messages'] = books.length
    for (const b of books) add({ userId: _owner(b.userId), kind: 'portfolio', entityId: b.portfolioId, agent: 'portfolio' }, {
        source: `book:${b.portfolioId}`, at: b.savedAt ?? 0, messages: msgs(b.messages),
        clear: () => db.collection(BOOKS).updateOne({ portfolioId: b.portfolioId, userId: b.userId }, { $unset: { messages: '' } }),
    })
    report.merged = { contexts: groups.size, sources: [...groups.values()].reduce((n, g) => n + g.sources.length, 0) }

    if (apply) {
        // ── 2. One import per context, then its sources go ──
        for (const { key, sources } of groups.values()) {
            const merged = mergeSources(sources)
            const res = await contexts.importLegacy({ ...key, messages: merged.messages, sources: sources.map(s => s.source), at: merged.at })
            if (res.imported) report.contexts++
            if (merged.dropped) tally(report.skipped, 'copy_of_another_source')
            if (settled(res, `${key.kind}:${key.entityId}`)) for (const s of sources) await s.clear()
        }
        // ── 3. Drafts → archived sessions; the rest of the threads go ──
        for (const t of drafts) {
            const at = Number.isFinite(t.createdAt) ? t.createdAt : null
            const res = await sessions.importArchived({
                userId: t.userId, title: t.title ?? null, source: `thread:${t.threadId}`, createdAt: at, archivedAt: t.updatedAt ?? at,
                messages: msgs(t.messages).map(m => ({ agent: CHAT_DESKS.has(t.agent) ? t.agent : 'axl', role: m.role, content: m.content, at })),
            })
            if (res.imported) report.sessions++
            if (settled(res, `thread:${t.threadId}`)) await db.collection(THREADS).deleteOne({ threadId: t.threadId })
        }
        for (const id of threadDeletes) await db.collection(THREADS).deleteOne({ threadId: id })
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
