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
import { getDb }           from '../../providers/mongodb.provider.js'
import { logger }          from '../../services/logger.service.js'
import { cleanConviction } from '../../services/conviction.util.js'
import { makeEntityCrud }  from '../../services/entity/entityCrud.service.js'

const LOG        = '[coverage]'
const COLLECTION = 'coverage'

// Owner-scoped CRUD (the shared mechanism), same factory the entity kinds use. Coverage differs
// only in its wiring, not its rules: its own collection, no `kind` discriminator, and recency is
// `updated_at` — a thesis is as fresh as its last revision, not its initiation.
//
// No deleteLock: retiring is a STATUS change through updateCoverage, not a delete. What stays
// below is coverage judgment — one-per-(user,symbol) initiation, the revision trail, and which
// plan fields an update may rewrite.
const crud = makeEntityCrud({
    collection: COLLECTION,
    sortBy:     { updated_at: -1 },
    log:        LOG,
})

// Rating vocabulary — mirrors FMP grades-consensus so our rating and the Street's are comparable.
export const RATINGS  = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell']
// Lifecycle. active = live thesis; target_hit / thesis_broken = terminal-but-kept for the record;
// retired = churned out of the book; watchlist = proposed (e.g. an Argus hit) but not yet initiated.
export const STATUSES = ['active', 'thesis_broken', 'target_hit', 'retired', 'watchlist']
const DEFAULT_STATUS = 'active'

// Plan fields re-written on an update; identity (id/userId/symbol/created_at) + revisions history
// are preserved out of band.
const PLAN_FIELDS = ['sector', 'thesis', 'rating', 'price_target', 'estimates', 'gap',
    'catalysts', 'kill_criteria', 'risk_reward', 'conviction', 'status', 'evidence']

export const coverageService = { initiateCoverage, getCoverage, getCoverageById, updateCoverage, retireCoverage, deleteCoverage, captureResearchBasis }

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
/**
 * THE GAP — our PT against the Street's, kept as a DISTRIBUTION rather than a single number.
 *
 * The Street arrives as {consensus, high, low, median} and only `consensus` used to survive, which
 * flattered every thesis: "12% below the Street" sounds contrarian, but with targets spanning
 * 500–700 our 516 sits in the 8th percentile of a crowded range — an analyst is already lower than
 * us. `pctile` is that position, and it is the honest read of a variant view; `pct` (vs the mean) is
 * kept because it is what the existing card copy and FE render.
 */
function _gap(g) {
    if (!g || typeof g !== 'object') return null
    const our_pt = _num(g.our_pt), consensus_pt = _num(g.consensus_pt), pct = _num(g.pct)
    const low = _num(g.low), high = _num(g.high), median = _num(g.median), pctile = _num(g.pctile)
    if (our_pt === null && consensus_pt === null && pct === null && low === null && high === null) return null
    return { our_pt, consensus_pt, pct, low, high, median, pctile }
}
// One valuation leg → { value, multiple, forward_metric }. A bare number is accepted and widened
// (legacy docs predate the inputs); anything else is null.
function _leg(v) {
    if (v === null || v === undefined) return null
    if (typeof v === 'object' && !Array.isArray(v)) {
        const value = _num(v.value)
        return value === null ? null : { value, multiple: _num(v.multiple), forward_metric: _num(v.forward_metric) }
    }
    const value = _num(v)
    return value === null ? null : { value, multiple: null, forward_metric: null }
}

/**
 * The bear/base/bull band, each leg carrying the inputs that produced it, plus `band_basis` naming
 * what the band MEANS ('scenario' = own multiple + own earnings per leg; 'multiple_sensitivity' =
 * ±15% re-rate on unchanged earnings). Both come straight from valuation.engine.
 *
 * `ordered:false` is stamped when bear < base < bull does not hold. It is recorded rather than
 * rejected — a malformed band must not silently vanish and take the thesis with it — but it flags a
 * band that was hand-written rather than computed. That is not hypothetical: SNDK was persisted with
 * a bull matching the engine exactly (2530) and a bear that did not (700 vs the engine's 1870),
 * because nothing here ever compared the emitted band against the tool's own output.
 */
function _riskReward(rr) {
    if (!rr || typeof rr !== 'object') return null
    const bull = _leg(rr.bull), base = _leg(rr.base), bear = _leg(rr.bear)
    if (bull === null && base === null && bear === null) return null

    const vals = [bear?.value, base?.value, bull?.value]
    const ordered = vals.every(v => v !== null && v !== undefined)
        ? (vals[0] < vals[1] && vals[1] < vals[2])
        : true   // an incomplete band can't be judged out of order

    return {
        bear, base, bull,
        band_basis: ['scenario', 'multiple_sensitivity'].includes(rr.band_basis) ? rr.band_basis : null,
        ordered,
    }
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
        // Owner — camelCase like every other owner-scoped list (the payload below stays snake_case).
        userId,
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
        // Coverage-monitor bookkeeping (P5) — written by the monitor, not a plan field. next_check_at
        // null → due on the next tick. Preserved across plan updates (updateCoverage never $sets it).
        monitor:       (r.monitor && typeof r.monitor === 'object' && !Array.isArray(r.monitor))
            ? r.monitor : { next_check_at: null, last_checked: null, checks: 0 },
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
    await db.collection(COLLECTION).createIndex({ userId: 1, symbol: 1 }, { unique: true })
    await db.collection(COLLECTION).createIndex({ userId: 1, status: 1 })
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
        const existing = await db.collection(COLLECTION).findOne({ userId, symbol })
        if (existing) return { ok: false, reason: 'already_covered', id: existing.id }

        const doc = normalizeCoverage(raw, userId)
        doc.revisions = [newRevision({ kind: 'initiate', note: _str(raw?.init_note) ?? `Initiated coverage on ${symbol}` })]
        const saved = await crud.insert(doc)
        logger.info(LOG, 'coverage initiated', { id: doc.id, symbol, sector: doc.sector })
        return { ok: true, doc: saved }
    } catch (err) {
        // Lost the race to a concurrent initiate on the same (user, symbol) → unique-index conflict.
        if (err?.code === 11000) return { ok: false, reason: 'already_covered' }
        logger.error(LOG, 'Failed to initiate coverage', err)
        return { ok: false, error: err }
    }
}

async function getCoverage(userId, { sector = null, status = null, onError } = {}) {
    // Validate/coerce the filters — never let a raw query param (e.g. status[$ne]) inject a Mongo operator.
    const filter = {}
    if (typeof sector === 'string' && sector.trim()) filter.sector = sector.trim()
    if (typeof status === 'string' && STATUSES.includes(status)) filter.status = status
    return crud.list(userId, { filter, onError })
}

// The shared crud's shape, `{ ok, doc }` — the same one every other kind's service answers in.
async function getCoverageById(id, userId) {
    return crud.getOwnedStripped(id, userId)
}

// In-place update of a live thesis. Re-normalizes the patch merged over current (partial patches keep
// prior fields + identity), APPENDS a revision (never loses history), preserves created_at.
async function updateCoverage(id, patch, userId) {
    const found = await crud.getOwned(id, userId)
    if (!found.ok) return found
    const cur = found.doc

    const p      = (patch && typeof patch === 'object') ? patch : {}
    const merged = normalizeCoverage(
        { ...cur, ...p, id: cur.id, symbol: cur.symbol, created_at: cur.created_at, revisions: cur.revisions },
        cur.userId ?? userId,
    )
    const revision = newRevision({ kind: _str(p.revision_kind) ?? 'update', note: _str(p.revision_note), changed: _diffPlan(cur, merged) })
    const revisions = [revision, ..._arr(cur.revisions)]

    const $set = { updated_at: merged.updated_at, revisions }
    for (const k of PLAN_FIELDS) $set[k] = merged[k]

    const res = await crud.patchOwned(id, userId, $set)
    if (!res.ok) return res
    logger.info(LOG, 'coverage updated', { id, kind: revision.kind })
    return res
}

/**
 * The research a position is being opened ON, frozen for the life of that position:
 * `{ coverageId, coveragePt, at }`, or null when the name isn't covered.
 *
 * WHY IT IS FROZEN. Invalidation belongs to the POSITION, not to the research — a thesis whose price
 * falls is cheaper, not wrong — so what a held name needs is "has our own price target moved against
 * what we paid?". That question needs a fixed "what we believed at entry" to measure from, and the
 * live coverage doc is precisely the thing that moves.
 *
 * Best-effort BY DESIGN: research is not a precondition for trading, and no order may fail because
 * the coverage book was unreachable. Any problem → null, and the gate simply never fires.
 *
 * Shared by every path into a live position (broker placement and manual fill both call it) so the
 * two can't drift into freezing different things.
 */
async function captureResearchBasis({ userId, symbol } = {}, deps = { getCoverage }) {
    try {
        const sym = String(symbol ?? '').toUpperCase().trim()
        if (!sym || !userId) return null
        const rows = await deps.getCoverage(userId)
        const cov  = (Array.isArray(rows) ? rows : []).find(c => String(c.symbol ?? '').toUpperCase() === sym)
        const pt   = _num(cov?.price_target?.value)
        if (!cov || pt === null) return null
        return { coverageId: cov.id, coveragePt: pt, at: new Date().toISOString() }
    } catch (err) {
        logger.warn(LOG, 'research basis capture failed (caller unaffected)', err.message)
        return null
    }
}

// Churn a name out of the book (S5) — a status change to `retired`, logged as a revision. The doc and
// its whole revision trail stay: a retired thesis is archived research, not deleted research.
async function retireCoverage(id, userId) {
    return updateCoverage(id, { status: 'retired', revision_kind: 'retire', revision_note: 'Coverage retired' }, userId)
}

/**
 * REMOVE the document — permanently, trail and all. The one operation `retireCoverage` deliberately
 * is not.
 *
 * Retiring is the normal way a name leaves the book, because the revision history is usually the
 * most valuable thing on the doc. Delete is for research that should never have existed: a mistaken
 * ticker, a test run, a duplicate. There is no undo, so the UI confirms first.
 *
 * No deleteLock: unlike an execution-tier entity there is no broker state to strand, and a held name
 * losing its coverage costs only the review gate's basis comparison — never a position.
 */
async function deleteCoverage(id, userId) {
    return crud.remove(id, userId)
}
