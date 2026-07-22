// Persistence for the Analyst's `coverage` — the living per-name research thesis (P1 of the
// Analyst build; see project_analyst_agent). One document per name per user in the `coverage`
// collection: identity + the variant-perception thesis + our price target vs the Street (the GAP =
// the edge) + monitorable kill-criteria + an append-only `revisions[]` history (the "living" part).
//
// This module owns persistence + the schema normalizer. It is NOT part of the execution-tier
// `entities` collection (idea/call/portfolio_item) — coverage is a research artifact, monitored by
// its own coverage-monitor (P5), not by Minos/Hermes/Themis. compute_valuation (P2) fills
// estimates/price_target/gap; the Analyst agent (P3) authors the thesis.

import { randomUUID }      from 'crypto'
import { getDb, stripId }  from '../../providers/mongodb.provider.js'
import { logger }          from '../../services/logger.service.js'
import { cleanConviction } from '../../services/conviction.util.js'

const LOG        = '[coverage]'
const COLLECTION = 'coverage'

// Rating vocabulary — mirrors FMP grades-consensus so our rating and the Street's are comparable.
export const RATINGS  = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell']
// Lifecycle. active = live thesis; target_hit / thesis_broken = terminal-but-kept for the record;
// retired = churned out of the book; watchlist = proposed (e.g. an Argus hit) but not yet initiated.
export const STATUSES = ['active', 'thesis_broken', 'target_hit', 'retired', 'watchlist']
const DEFAULT_STATUS = 'active'

// Plan fields re-written on an update; identity (id/user_id/symbol/created_at) + revisions history
// are preserved out of band.
const PLAN_FIELDS = ['sector', 'thesis', 'rating', 'price_target', 'estimates', 'gap',
    'catalysts', 'kill_criteria', 'risk_reward', 'conviction', 'status']

export const coverageService = { initiateCoverage, getCoverage, getCoverageById, updateCoverage, retireCoverage }

// Exported for tests + downstream phases (P2 valuation, P3 agent, P5 monitor).
export { normalizeCoverage, newRevision }

// ─── pure helpers ──────────────────────────────────────────────────────────────
const _str = v => (typeof v === 'string' && v.trim() ? v.trim() : null)
const _arr = v => (Array.isArray(v) ? v : [])
function _num(v) {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
}
function _priceTarget(pt) {
    if (!pt || typeof pt !== 'object') return null
    const value = _num(pt.value)
    if (value === null) return null   // a PT with no number is meaningless
    return { value, horizon: _str(pt.horizon), basis: _str(pt.basis) }
}
function _gap(g) {
    if (!g || typeof g !== 'object') return null
    const our_pt = _num(g.our_pt), consensus_pt = _num(g.consensus_pt), pct = _num(g.pct)
    return (our_pt === null && consensus_pt === null && pct === null) ? null : { our_pt, consensus_pt, pct }
}
function _riskReward(rr) {
    if (!rr || typeof rr !== 'object') return null
    const bull = _num(rr.bull), base = _num(rr.base), bear = _num(rr.bear)
    return (bull === null && base === null && bear === null) ? null : { bull, base, bear }
}

/**
 * Defensively normalize a raw coverage object (from the agent, an update patch, or a manual create)
 * into the stored shape. Pure. Symbol is uppercased; unknown rating/status → null/default; numeric
 * fields coerced or nulled; arrays guaranteed. `estimates`/`gap`/`price_target` may be empty until
 * compute_valuation (P2) fills them. Identity + timestamps are stamped here.
 */
function normalizeCoverage(raw, userId = null) {
    const r = (raw && typeof raw === 'object') ? raw : {}
    const symbol = (typeof r.symbol === 'string' ? r.symbol : '').toUpperCase().trim()
    const now = new Date().toISOString()
    return {
        id:            _str(r.id) ?? `cov_${symbol || 'x'}_${randomUUID().slice(0, 8)}`,
        user_id:       userId,
        symbol,
        sector:        _str(r.sector),
        thesis:        _str(r.thesis),                 // the VARIANT PERCEPTION vs consensus
        rating:        RATINGS.includes(r.rating) ? r.rating : null,
        price_target:  _priceTarget(r.price_target),   // OUR target (P2)
        estimates:     (r.estimates && typeof r.estimates === 'object' && !Array.isArray(r.estimates)) ? r.estimates : {}, // {ours, consensus, revision_trend} (P2)
        gap:           _gap(r.gap),                    // our PT vs Street — the edge (P2)
        catalysts:     _arr(r.catalysts),
        kill_criteria: _arr(r.kill_criteria),          // MONITORABLE (P5)
        risk_reward:   _riskReward(r.risk_reward),      // {bull, base, bear}
        conviction:    cleanConviction(r.conviction),
        status:        STATUSES.includes(r.status) ? r.status : DEFAULT_STATUS,
        revisions:     _arr(r.revisions),               // append-only history (the "living" part)
        evidence:      _arr(r.evidence),
        created_at:    _str(r.created_at) ?? now,
        updated_at:    now,
    }
}

/** Build one revision-log entry (the living trail). Pure. `changed` = {field:{from,to}}. */
function newRevision({ kind = null, note = null, changed = null, at = null } = {}) {
    return {
        at:      _str(at) ?? new Date().toISOString(),
        kind:    _str(kind),        // 'initiate' | 'remodel' | 'rating_change' | 'thesis_broken' | 'target_hit' | 'retire' | 'update'
        note:    _str(note),
        changed: (changed && typeof changed === 'object') ? changed : null,
    }
}

// Shallow diff of the plan fields worth logging on an update (for the revision trail).
function _diffPlan(prev, next) {
    const changed = {}
    for (const k of ['rating', 'status', 'price_target', 'thesis']) {
        if (JSON.stringify(prev?.[k] ?? null) !== JSON.stringify(next?.[k] ?? null)) {
            changed[k] = { from: prev?.[k] ?? null, to: next?.[k] ?? null }
        }
    }
    return Object.keys(changed).length ? changed : null
}

async function _ensureIndexes(db) {
    await db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true })
    // One coverage per (user, symbol) — unique is the race backstop for the initiate check below.
    await db.collection(COLLECTION).createIndex({ user_id: 1, symbol: 1 }, { unique: true })
    await db.collection(COLLECTION).createIndex({ user_id: 1, status: 1 })
}

// ─── CRUD ────────────────────────────────────────────────────────────────────
// Initiation is an EVENT — one coverage per (user, symbol). A second initiate on the same name is a
// conflict (use updateCoverage to change a live thesis). Stamps the initiation as the first revision.
async function initiateCoverage(raw, userId) {
    const symbol = (typeof raw?.symbol === 'string' ? raw.symbol : '').toUpperCase().trim()
    if (!symbol) return { ok: false, reason: 'symbol_required' }
    try {
        const db = await getDb()
        await _ensureIndexes(db)
        const existing = await db.collection(COLLECTION).findOne({ user_id: userId, symbol })
        if (existing) return { ok: false, reason: 'already_covered', id: existing.id }

        const doc = normalizeCoverage(raw, userId)
        doc.revisions = [newRevision({ kind: 'initiate', note: _str(raw?.init_note) ?? `Initiated coverage on ${symbol}` })]
        await db.collection(COLLECTION).insertOne(doc)
        logger.info(LOG, 'coverage initiated', { id: doc.id, symbol, sector: doc.sector })
        return { ok: true, coverage: stripId(doc) }
    } catch (err) {
        // Lost the race to a concurrent initiate on the same (user, symbol) → unique-index conflict.
        if (err?.code === 11000) return { ok: false, reason: 'already_covered' }
        logger.error(LOG, 'Failed to initiate coverage', err)
        return { ok: false, error: err }
    }
}

async function getCoverage(userId, { sector = null, status = null } = {}, isAdmin = false) {
    try {
        const db = await getDb()
        const query = isAdmin ? {} : { user_id: userId }
        if (sector) query.sector = sector
        if (status) query.status = status
        const rows = await db.collection(COLLECTION).find(query).sort({ updated_at: -1 }).toArray()
        return rows.map(stripId)
    } catch (err) {
        logger.error(LOG, 'Failed to get coverage', err)
        return []
    }
}

async function getCoverageById(id, userId, isAdmin = false) {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne({ id })
        if (!doc) return { ok: false, reason: 'not_found' }
        if (doc.user_id && doc.user_id !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }
        return { ok: true, coverage: stripId(doc) }
    } catch (err) {
        logger.error(LOG, 'Failed to get coverage by id', err)
        return { ok: false, error: err }
    }
}

// In-place update of a live thesis. Re-normalizes the patch merged over current (partial patches keep
// prior fields + identity), APPENDS a revision (never loses history), preserves created_at.
async function updateCoverage(id, patch, userId, isAdmin = false) {
    try {
        const db  = await getDb()
        const cur = await db.collection(COLLECTION).findOne({ id })
        if (!cur) return { ok: false, reason: 'not_found' }
        if (cur.user_id && cur.user_id !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }

        const p      = (patch && typeof patch === 'object') ? patch : {}
        const merged = normalizeCoverage(
            { ...cur, ...p, id: cur.id, symbol: cur.symbol, created_at: cur.created_at, revisions: cur.revisions },
            cur.user_id ?? userId,
        )
        const revision = newRevision({ kind: _str(p.revision_kind) ?? 'update', note: _str(p.revision_note), changed: _diffPlan(cur, merged) })
        const revisions = [revision, ..._arr(cur.revisions)]

        const $set = { updated_at: merged.updated_at, revisions }
        for (const k of PLAN_FIELDS) $set[k] = merged[k]

        const updated = await db.collection(COLLECTION).findOneAndUpdate({ id }, { $set }, { returnDocument: 'after' })
        logger.info(LOG, 'coverage updated', { id, kind: revision.kind })
        return { ok: true, coverage: stripId(updated) }
    } catch (err) {
        logger.error(LOG, 'Failed to update coverage', err)
        return { ok: false, error: err }
    }
}

// Churn a name out of the book (S5) — a status change to `retired`, logged as a revision.
async function retireCoverage(id, userId, isAdmin = false) {
    return updateCoverage(id, { status: 'retired', revision_kind: 'retire', revision_note: 'Coverage retired' }, userId, isAdmin)
}
