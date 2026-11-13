// ABOUT YOU — the one record every role reads (docs/design/one-axl.md §4, step 3, 2026-11-13).
//
// The user meets ONE assistant, so "I told you I risk 1%" must hold whichever role answers next — yet each role still
// reads only its own segment of the chat (unified-chat.md §3.2: cost and focus). This record is the bridge: small,
// per user, read by every chat role on every turn, as one block beside the experience level (buildAudienceSection).
//
// WRITTEN BY THE WORK, NEVER BY ASKING (the removed `save_objective` lesson — reception interrogating the user):
//   • size   — the risk / size the user last gave a trade build (Mentor's ledger settled it). Shares are per name and
//              are not kept.
//   • notes  — a lasting fact or preference the user STATED ("no low-float names", "I only trade the open"), saved by
//              whichever role heard it (`remember_about_user`), removed when they take it back.
// And one part never stored, so it cannot go stale: WHAT IS ON THE TABLE now, read off the session's agent states.
//
// Reads are cached and best-effort, like experience.service: a profile is a nicety; a turn never fails for it.

import { getDb } from '../providers/mongodb.provider.js'
import { logger } from './logger.service.js'
import { createTtlCache } from './ttlCache.util.js'
import { DESKS } from './desks/registry.js'

const LOG = '[userProfile]'
export const COLLECTION = 'user_profile'
export const MAX_NOTES = 12
export const NOTE_MAX = 160
/** The sizes that mean the same thing on the next trade — a share count belongs to one name. */
export const PORTABLE_UNITS = Object.freeze(['risk_pct', 'risk_cash', 'size_pct', 'size_cash'])

const _uid = (u) => String(u ?? '')
const _norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim()

export function makeUserProfileService({ db: getDbFn = getDb, now = () => Date.now() } = {}) {
    // Per instance: a write busts it at once ("forget that" holds on the very next reply), and tests get their own.
    const _cache = createTtlCache({ ttlMs: 5 * 60 * 1000, max: 500 })

    /** The stored record, or an empty one. Never throws. */
    async function read(userId) {
        const uid = _uid(userId)
        if (!uid) return { notes: [], size: null }
        const hit = _cache.get(uid)
        if (hit) return hit
        try {
            const db = await getDbFn()
            const doc = await db.collection(COLLECTION).findOne({ userId: uid }, { projection: { _id: 0 } })
            const out = { notes: Array.isArray(doc?.notes) ? doc.notes : [], size: doc?.size ?? null }
            _cache.set(uid, out)
            return out
        } catch (err) {
            logger.warn(LOG, 'read failed — the turn goes on without it', err.message)
            return { notes: [], size: null }
        }
    }

    async function _write(uid, patch) {
        const db = await getDbFn()
        await db.collection(COLLECTION).updateOne({ userId: uid }, { $set: { ...patch, updatedAt: now() } }, { upsert: true })
        _cache.delete(uid)
    }

    /**
     * Remember a lasting fact the user stated. Trimmed and cut; a note already there (any case) is not added twice; past
     * MAX_NOTES the oldest goes. Returns { ok, notes } or { ok:false, reason }.
     */
    async function remember(userId, text, { by = null } = {}) {
        const uid = _uid(userId), note = _norm(text).slice(0, NOTE_MAX)
        if (!uid) return { ok: false, reason: 'no_user' }
        if (!note) return { ok: false, reason: 'empty' }
        const cur = (await read(uid)).notes
        if (cur.some(n => n.text.toLowerCase() === note.toLowerCase())) return { ok: true, notes: cur, unchanged: true }
        const notes = [...cur, { text: note, at: now(), by }].slice(-MAX_NOTES)
        await _write(uid, { notes })
        return { ok: true, notes }
    }

    /** Take a note back — every note containing `text` (case-insensitive). Returns how many went. */
    async function forget(userId, text) {
        const uid = _uid(userId), q = _norm(text).toLowerCase()
        if (!uid || !q) return { ok: false, reason: 'empty' }
        const cur = (await read(uid)).notes
        const notes = cur.filter(n => !n.text.toLowerCase().includes(q))
        if (notes.length === cur.length) return { ok: true, removed: 0, notes: cur }
        await _write(uid, { notes })
        return { ok: true, removed: cur.length - notes.length, notes }
    }

    /** The size the user last gave a trade, when it carries to the next one. Unchanged → no write. */
    async function noteSize(userId, size, { asset = null } = {}) {
        const uid = _uid(userId)
        const unit = size?.unit, value = Number(size?.value)
        if (!uid || !PORTABLE_UNITS.includes(unit) || !(value > 0)) return { ok: false, reason: 'not_portable' }
        const cur = (await read(uid)).size
        if (cur?.unit === unit && cur?.value === value) return { ok: true, unchanged: true }
        await _write(uid, { size: { unit, value, asset: asset ? String(asset).toUpperCase() : null, at: now() } })
        return { ok: true }
    }

    return { read, remember, forget, noteSize }
}

export const userProfileService = makeUserProfileService()

// ─── Pure: the block every role reads ─────────────────────────────────────────

/** "1% of the account" / "$1,000 at risk" / "10% of the account in the position". Pure. */
export function sizeWords(size) {
    if (!size) return null
    const v = Number(size.value)
    const money = (x) => `$${x.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    switch (size.unit) {
        case 'risk_pct':  return `${v}% of the account at risk`
        case 'risk_cash': return `${money(v)} at risk`
        case 'size_pct':  return `${v}% of the account in the position`
        case 'size_cash': return `${money(v)} in the position`
        default: return null
    }
}

const _role = (agent) => DESKS[agent]?.role ?? null

/**
 * What is on the table now, one line per role that holds work, from the session's agent states. The role answering
 * this turn is left out — it has its own state in front of it. Pure.
 */
export function workingOnLines(agentState, currentAgent = null) {
    const out = []
    for (const [agent, st] of Object.entries(agentState ?? {})) {
        if (agent === currentAgent || !st || typeof st !== 'object') continue
        const role = _role(agent)
        if (!role) continue
        if (st.editing?.kind) {
            out.push(`with the ${role}: reopened ${String(st.editing.kind).replace('_', ' ')} ${st.editing.name ?? st.editing.entityId ?? ''}`.trim())
            continue
        }
        const d = st.draft
        if (agent === 'mentor' && d?.asset) {
            const dir = d.direction ? `${String(d.direction).toLowerCase()} ` : ''
            out.push(`with the ${role}: building a ${dir}trade on ${String(d.asset).toUpperCase()} (not saved yet)`)
        }
    }
    return out
}

/**
 * The block, or null when there is nothing to say. Facts only — what the user said and what is open — never a
 * judgment about them. Pure.
 */
export function aboutSection({ profile = null, working = [] } = {}) {
    const lines = []
    const size = sizeWords(profile?.size)
    if (size) lines.push(`- The size they last gave a trade: ${size}${profile.size.asset ? ` (on ${profile.size.asset})` : ''}. A default to offer, never to assume — they choose each trade's size.`)
    for (const n of profile?.notes ?? []) lines.push(`- They told us: "${n.text}"`)
    for (const w of working) lines.push(`- On the table ${w}.`)
    if (!lines.length) return null
    return ['ABOUT THE USER (shared by every role — what they told any of us, and what is open; use it, do not recite it):', ...lines].join('\n')
}
