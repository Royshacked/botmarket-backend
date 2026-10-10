// The theme registry — Pythia's themes (docs/design/pythia-assessment.md §3, build step 3).
//
// Money and news move by THEME — AI, power for data centres, defence, GLP-1 — and a theme crosses GICS: AI
// runs from software through chips to electrical equipment and power producers. A theme here is a value
// chain written as GICS sub-industries in ORDER: 1 = the theme itself (direct), 2 = its suppliers, 3 = the
// suppliers' suppliers — each link with the reason it belongs — plus the words its filings and news use.
//
// PYTHIA PROPOSES, THE ADMIN APPROVES (Roy, 2026-10-10), the first themes included: a proposed theme is
// shown to admins only and is never assessed; approved is the house list; retired keeps its trail. One
// house document per theme, written through the house artifact repo, so every change appends a revision.

import { getDb } from '../../providers/mongodb.provider.js'
import { makeHouseArtifactRepo } from '../../services/houseArtifact.repo.js'
import { newRevision } from '../../services/revisionTrail.js'

export const COLLECTION = 'theme'
export const STATUSES = Object.freeze(['proposed', 'approved', 'retired'])
export const ORDER_LABEL = Object.freeze({ 1: 'direct', 2: 'suppliers', 3: "suppliers' suppliers" })
export const MAX_LINKS = 12
export const MAX_BASKET = 30
export const MAX_TERMS = 8

const _io = { db: () => getDb() }
const _repo = makeHouseArtifactRepo({ collection: COLLECTION, getDb: () => _io.db() })
/** Test seam. */
export function _setThemeIO(io) { Object.assign(_io, io) }

const _str = (v, max = 600) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** A theme's id from its name: th_data_center_power. Pure. */
export function themeId(name) {
    const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
    return slug ? `th_${slug}` : null
}

/**
 * One <theme_proposal> block, checked → `{ ok, theme, dropped }` or `{ ok:false, detail }`. Pure.
 * `subs` maps each measured sub-industry code to `{ name, sector }`; `symbols` is the set of tickers in the
 * universe. Refused without a name, a thesis, search terms, two links of which one is direct (order 1),
 * each link a measured sub-industry with an order and a reason. Basket names outside the universe are
 * dropped and listed, not refused.
 */
export function checkThemeProposal(block, subs, symbols = new Set()) {
    if (!block || typeof block !== 'object') return { ok: false, detail: 'no block' }
    const name = _str(block.name, 60)
    const id = themeId(name)
    const problems = []
    if (!id) problems.push('name is missing')
    const thesis = _str(block.thesis, 700)
    if (!thesis) problems.push('thesis is missing')
    const terms = (Array.isArray(block.terms) ? block.terms : []).map(t => _str(t, 60)).filter(Boolean).slice(0, MAX_TERMS)
    if (!terms.length) problems.push('terms: the words its filings and news use (at least one)')
    const links = []
    const seen = new Set()
    for (const l of Array.isArray(block.links) ? block.links : []) {
        const code = _str(l?.industry, 16)
        const order = Number(l?.order)
        const why = _str(l?.why, 300)
        if (!code || !/^\d{8}$/.test(code) || !subs.get(code)) { problems.push(`link ${code ?? '?'}: not a measured GICS sub-industry`); continue }
        if (![1, 2, 3].includes(order)) { problems.push(`link ${code}: order must be 1, 2 or 3`); continue }
        if (!why) { problems.push(`link ${code}: say why it belongs`); continue }
        if (seen.has(code)) continue
        seen.add(code)
        links.push({ code, name: subs.get(code).name, sector: subs.get(code).sector ?? null, order, why })
    }
    if (links.length < 2) problems.push('links: at least two sub-industries')
    if (links.length && !links.some(l => l.order === 1)) problems.push('links: at least one direct (order 1)')
    if (links.length > MAX_LINKS) problems.push(`links: at most ${MAX_LINKS}`)
    if (problems.length) return { ok: false, detail: `${name ?? 'theme'}: ${problems.join('; ')}` }
    const basket = [], dropped = []
    for (const b of (Array.isArray(block.basket) ? block.basket : []).slice(0, MAX_BASKET)) {
        const symbol = _str(typeof b === 'string' ? b : b?.symbol, 12)?.toUpperCase()
        if (!symbol) continue
        if (!symbols.has(symbol)) { dropped.push(symbol); continue }
        basket.push({ symbol, why: _str(b?.why, 200) })
    }
    links.sort((a, b) => a.order - b.order)
    return { ok: true, dropped, theme: { id, name, thesis, terms, links, basket } }
}

/** Once, at boot (server.js). */
export async function ensureThemeIndexes() {
    const db = await _io.db()
    await db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true })
    await db.collection(COLLECTION).createIndex({ status: 1 })
}

/**
 * Store a checked proposal → `{ ok, doc, created }` or `{ ok:false, reason }`. A new theme starts
 * `proposed`; a proposed or retired one is revised and (re)proposed; an APPROVED theme is not changed by a
 * proposal — `already_approved` — so the house list only moves by an admin's hand.
 */
async function proposeTheme(theme, { now = new Date().toISOString(), source = 'pythia', note = null } = {}) {
    const db = await _io.db()
    const cur = await db.collection(COLLECTION).findOne({ id: theme.id })
    if (cur?.status === 'approved') return { ok: false, reason: 'already_approved', detail: `${theme.name} is already on the house list` }
    if (!cur) await db.collection(COLLECTION).insertOne({ id: theme.id, revisions: [], created_at: now })
    await _repo.revise(theme.id, {
        name: theme.name, thesis: theme.thesis, terms: theme.terms, links: theme.links, basket: theme.basket,
        status: 'proposed', proposed_at: now, proposed_by: source, updated_at: now,
    }, newRevision({ kind: cur ? 'reproposed' : 'proposed', note: note ?? theme.thesis, at: now }))
    return { ok: true, created: !cur, doc: await db.collection(COLLECTION).findOne({ id: theme.id }, { projection: { _id: 0 } }) }
}

/** An admin approves or retires a theme → `{ ok, doc }` or `{ ok:false, reason }`. */
async function setStatus(id, status, { by = null, note = null, now = new Date().toISOString() } = {}) {
    if (!['approved', 'retired'].includes(status)) return { ok: false, reason: 'bad_status' }
    const db = await _io.db()
    const cur = await db.collection(COLLECTION).findOne({ id })
    if (!cur) return { ok: false, reason: 'not_found' }
    if (cur.status === status) return { ok: true, doc: cur }
    await _repo.revise(id, { status, [`${status}_at`]: now, [`${status}_by`]: by, updated_at: now },
        newRevision({ kind: status, note, changed: { status: { from: cur.status, to: status } }, at: now }))
    return { ok: true, doc: await db.collection(COLLECTION).findOne({ id }, { projection: { _id: 0 } }) }
}

/** Themes, newest first; `statuses` narrows (a trader sees approved only). */
async function listThemes({ statuses = STATUSES } = {}) {
    const db = await _io.db()
    return db.collection(COLLECTION).find({ status: { $in: [...statuses] } }, { projection: { _id: 0, revisions: 0 } })
        .sort({ updated_at: -1 }).toArray()
}

async function getTheme(id) {
    const db = await _io.db()
    return db.collection(COLLECTION).findOne({ id }, { projection: { _id: 0 } })
}

export const themeService = { proposeTheme, setStatus, listThemes, getTheme }
