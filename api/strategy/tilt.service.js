// Persistence + schema normalizer for the strategy desk's `tilt` — Pythia's standing top-down view.
//
// WHAT A TILT IS. A sector stance expressed the way real equity strategy expresses it: an ACTIVE
// WEIGHT against a benchmark, not an absolute return forecast. "Overweight Healthcare +150bp" says
// healthcare beats the index — it can be right in a falling market. That relativity is what makes it
// gradeable: `active_bp × relative return = contribution`, which is standard attribution rather than
// a judgment call. It is the one forecast in this app that both scores cleanly and drives a decision.
//
// WHY IT IS NOT `coverage`. Coverage is one doc per (user, symbol) — bottom-up, owner-scoped,
// per name. A tilt is ONE doc for the whole market: no symbol, and no `userId` at all. It is a
// BROADCAST, like the Axl brief: one house view serving every user, which Atlas then applies against
// a particular mandate. Never join it to a user's book.
//
// WHY NOT `makeEntityCrud`. That factory's `_scope(userId)` is not incidental — it is the guarantee
// that a list is only ever the caller's own. A broadcast doc has no owner, and bolting a
// skip-the-ownership-filter branch onto the one function whose job is never to skip it is how leaks
// get built. What this collection actually needs is a PUBLICATION LOG (one active view per
// benchmark, superseded ones kept for grading), which is a different mechanism, not a variation.
//
// The clock, the sector vocabulary and the revision trail ARE shared — see forecastClock,
// entity/vocabulary and revisionTrail.

import { randomUUID }      from 'crypto'
import { getDb }           from '../../providers/mongodb.provider.js'
import { logger }          from '../../services/logger.service.js'
import { toNum }           from '../../services/format.util.js'
import { normalizeSector, SECTORS, SECTOR_ETF, BENCHMARK_PROXY } from '../../services/entity/vocabulary.js'
import { openWindow, HORIZONS, DEFAULT_HORIZON } from '../../services/forecastClock.js'
import { newRevision, diffFields }  from '../../services/revisionTrail.js'

const LOG        = '[tilt]'
// Exported for the tilt monitor, which reads these documents on the background path. One name,
// owned by the service that owns the schema.
export const COLLECTION = 'tilt'

// ─── vocabulary ───────────────────────────────────────────────────────────────

/** Which way a sector is tilted against its benchmark weight. */
export const STANCES = ['over', 'neutral', 'under']

/**
 * WHY a stance was taken. Recorded per row because the four have very different evidential weight
 * and a reader deserves to know which one is carrying a call:
 *   • bottom_up        — our own covered names in the sector say so. Most defensible.
 *   • revisions        — sector estimate-revision momentum. The best-supported signal empirically.
 *   • valuation        — sector multiple vs its own history. Weak mean reversion, non-zero.
 *   • rate_sensitivity — the regime read mapped onto the sector's factor exposure. Top-down.
 */
export const TILT_BASES = ['bottom_up', 'revisions', 'valuation', 'rate_sensitivity']

/** Doc lifecycle. One `active` view per benchmark; publishing supersedes rather than overwrites. */
export const TILT_STATUSES = ['active', 'superseded', 'retired']
const DEFAULT_STATUS = 'active'

/** A row's own lifecycle — `open` while accruing, `matured` once its window closed and it was graded. */
export const ROW_STATES = ['open', 'matured']

/**
 * How far the table may be from netting to zero before it is flagged. A tilt table redistributes a
 * fully-invested book, so the active weights must net out; a few bp of rounding is fine, 400 is a
 * table someone wrote by hand rather than constructed.
 */
export const BALANCE_TOLERANCE_BP = 50

// ─── pure helpers ─────────────────────────────────────────────────────────────
const _str = v => (typeof v === 'string' && v.trim() ? v.trim() : null)
const _arr = v => (Array.isArray(v) ? v : [])
const _num = toNum   // the one safe coercion — see format.util.toNum

/**
 * One sector row. Pure. Returns null when it carries no usable sector — an unrecognised sector
 * cannot be joined against sector data or against our own book, so a row keyed on one is not a
 * stance, it is a sentence.
 *
 * The row owns its OWN clock, and that is the load-bearing detail. A monthly review typically
 * changes two sectors and reaffirms nine; if the clock lived on the document, every review would
 * reset all eleven and a 12-month call would never come due — the same unfalsifiability that a price
 * target without a deadline had. `openWindow` preserves `set_at` when the row carries one and
 * re-stamps when it does not, so reaffirming keeps the clock and re-authoring restarts it.
 */
function _row(raw, now) {
    if (!raw || typeof raw !== 'object') return null
    const sector = normalizeSector(raw.sector)
    if (!sector) return null

    const { horizon, set_at, ends_at } = openWindow(raw, now)
    return {
        sector,
        stance:    STANCES.includes(raw.stance) ? raw.stance : null,
        active_bp: _num(raw.active_bp),
        horizon,
        set_at,
        review_date:     ends_at,          // this schema's name for the window's end
        basis:           TILT_BASES.includes(raw.basis) ? raw.basis : null,
        rationale:       _str(raw.rationale),
        state:           ROW_STATES.includes(raw.state) ? raw.state : 'open',
        // The BASELINE this stance is graded from — the sector proxy and the benchmark as they stood
        // when the call was made, frozen onto the row (the same move captureResearchBasis makes for
        // a position's research). Attribution then needs only TODAY's prices.
        //
        // Not an optimisation: deep daily history is not reliably available here (a range fetch
        // 403s and only ~a month of bars is cached), so a stance authored six months ago could not
        // be re-based from data at all. Freezing it also makes the baseline immutable — a provider
        // revising history cannot silently re-score a closed call.
        //
        // Rides the same reaffirm-vs-restart rule as the clock: a row spread through a review keeps
        // its baseline alongside its `set_at`; a re-authored one gets a fresh pair.
        base_px:         _num(raw.base_px),
        base_bench_px:   _num(raw.base_bench_px),
        contribution_bp: _num(raw.contribution_bp),   // written by the monitor, not the author
    }
}

/**
 * Does a row's stance agree with its number? PURE → `{ ok }` | `{ ok: false, sector, detail }`.
 *
 * This is the sector-level twin of coverage's `ratingCoherence`, and it exists for the same reason
 * that one does: a `sell` rating with an upside target passed every gate and surfaced a day later as
 * a bogus verdict. Here the failure is worse than bogus — `active_bp` is what Atlas would actually
 * allocate on, so a row reading `stance: 'over'` with `active_bp: -150` would UNDERWEIGHT a sector
 * the desk meant to favour. The words and the number must agree before either reaches an allocator.
 */
export function stanceCoherence(row) {
    const { sector, stance, active_bp: bp } = row ?? {}
    if (!stance || bp === null || bp === undefined) return { ok: true }   // nothing claimed → nothing to contradict
    if (stance === 'over' && bp <= 0) {
        return { ok: false, sector, detail: `an "over" stance needs a positive active weight, got ${bp}bp` }
    }
    if (stance === 'under' && bp >= 0) {
        return { ok: false, sector, detail: `an "under" stance needs a negative active weight, got ${bp}bp` }
    }
    if (stance === 'neutral' && bp !== 0) {
        return { ok: false, sector, detail: `a "neutral" stance is 0bp by definition, got ${bp}bp` }
    }
    return { ok: true }
}

/**
 * The regime the tilts are read off — the BASIS, deliberately not its own entity.
 *
 * Same call as `price_target.basis`: the reasoning that produced the numbers belongs beside them,
 * not promoted to a second artifact with a second clock and a second monitor. `kill_criteria` are
 * what make the regime falsifiable and are the only thing the cheap daily watcher can act on, so a
 * regime without them is prose.
 */
function _regime(r) {
    if (!r || typeof r !== 'object') return null
    const name = _str(r.name), thesis = _str(r.thesis)
    const kill_criteria = _arr(r.kill_criteria).map(_str).filter(Boolean)
    if (!name && !thesis && !kill_criteria.length) return null
    return { name, thesis, kill_criteria }
}

/**
 * Defensively normalize a raw tilt into the stored shape. PURE — identity and timestamps stamped
 * here, rows canonicalised and de-duplicated, and the balance check recorded.
 *
 * `balanced: false` is RECORDED rather than rejected, following the same call as `ordered` on
 * coverage's valuation band: an unbalanced table is a construction smell worth seeing, not a
 * contradiction worth destroying the work over. A contradictory row IS worth refusing, and that gate
 * lives in `publishTilt` where the author can still fix it.
 */
export function normalizeTilt(raw, now = new Date().toISOString()) {
    const r = (raw && typeof raw === 'object') ? raw : {}
    const benchmark = _str(r.benchmark) ?? 'SPX'

    // One row per sector: two stances on one sector is a contradiction, not a richer view. First
    // wins, so a later duplicate can never quietly override an earlier stance.
    const seen = new Set()
    const tilts = _arr(r.tilts)
        .map(t => _row(t, now))
        .filter(t => t && !seen.has(t.sector) && seen.add(t.sector))

    const sum = tilts.reduce((acc, t) => acc + (t.active_bp ?? 0), 0)

    return {
        id:        _str(r.id) ?? `tilt_${benchmark}_${randomUUID().slice(0, 8)}`,
        benchmark,
        // NO userId — a house view is a broadcast (see the header).
        regime:    _regime(r.regime),
        tilts,
        net_bp:    Math.round(sum),
        balanced:  Math.abs(sum) <= BALANCE_TOLERANCE_BP,
        status:    TILT_STATUSES.includes(r.status) ? r.status : DEFAULT_STATUS,
        evidence:  _arr(r.evidence),
        revisions: _arr(r.revisions),
        monitor:   (r.monitor && typeof r.monitor === 'object' && !Array.isArray(r.monitor))
            ? r.monitor : { next_check_at: null, last_checked: null, checks: 0 },
        created_at: _str(r.created_at) ?? now,
        updated_at: now,
    }
}

/** Every row whose words disagree with its number. Pure — `[]` when the table is coherent. */
export function incoherentRows(doc) {
    return _arr(doc?.tilts).map(stanceCoherence).filter(c => !c.ok)
}

export const tiltService = { publishTilt, getCurrentTilt, getTiltById, listTilts, updateTilt, retireTilt, recordMonitorState }

/**
 * The monitor's bookkeeping write — the `monitor.*` subtree plus the graded `tilts` array.
 *
 * `updateTilt` is the PUBLICATION path: it appends a revision, which is right for a state change a
 * reader should see (a stance maturing) and wrong for a routine grade refresh — eleven revisions a
 * day would bury the trail that makes the view auditable. So the monitor had two paths and used a
 * raw `updateOne` for the quiet one, which put this collection's shape in a second file.
 *
 * The split stays; only the write moves here. `set` is a flat map (dotted `monitor.*` paths and/or
 * top-level fields), `inc` the counters.
 */
async function recordMonitorState(id, { set = {}, inc = null } = {}) {
    const db = await getDb()
    const update = { $set: set }
    if (inc) update.$inc = inc
    const res = await db.collection(COLLECTION).updateOne({ id }, update)
    return { ok: res.matchedCount === 1 }
}
export { HORIZONS, DEFAULT_HORIZON, SECTORS }

/**
 * The price read used to stamp a stance's baseline. Injected so tests exercise the stamping, and
 * imported LAZILY for the same reason coverage does it: importing this service must not drag the
 * whole monitor/provider stack in behind the pure normalizer.
 */
const _io = {
    priceFor: async (symbol) => {
        try {
            const { fetchLastPrice } = await import('../../monitoring/monitorUtils.js')
            return await fetchLastPrice(symbol)
        } catch { return null }
    },
}
export function _setTiltIO(io) { Object.assign(_io, io) }

/**
 * Stamp `base_px` / `base_bench_px` on any row that lacks them. Mutates the passed rows in place —
 * they are freshly normalized objects owned by the caller, never stored documents.
 *
 * Only rows MISSING a baseline are touched, which is what preserves a reaffirmed stance: it carries
 * its original prices through, so it is still graded from where it actually started rather than
 * being silently re-based at every review — the price-side twin of keeping `set_at`.
 *
 * A price we cannot read leaves the baseline null rather than guessing. The row is then ungradeable
 * until the monitor backfills it, which is a day of imprecision instead of a permanently unscoreable
 * call — and far better than freezing a wrong number as if it were fact.
 */
export async function stampBaselines(rows, benchmark = 'SPX', io = _io) {
    const bench = BENCHMARK_PROXY[benchmark] ?? null
    const needs = rows.filter(r => r.base_px === null || r.base_bench_px === null)
    if (!needs.length) return rows

    const benchPx = bench ? _num(await io.priceFor(bench)) : null
    for (const r of needs) {
        const proxy = SECTOR_ETF[r.sector] ?? null
        if (r.base_px === null && proxy)      r.base_px = _num(await io.priceFor(proxy))
        if (r.base_bench_px === null)         r.base_bench_px = benchPx
    }
    const unpriced = rows.filter(r => r.base_px === null || r.base_bench_px === null).map(r => r.sector)
    if (unpriced.length) logger.warn(LOG, 'stances published without a baseline — ungradeable until backfilled', { unpriced })
    return rows
}

async function _ensureIndexes(db) {
    await db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true })
    // The current-view lookup, and the history read behind it.
    await db.collection(COLLECTION).createIndex({ benchmark: 1, status: 1, created_at: -1 })
}

// ─── CRUD — a publication log, not a generic collection ───────────────────────

/**
 * Publish a new house view. The previous active one for this benchmark is SUPERSEDED, never
 * overwritten: a graded record of what we believed and when is the entire point of a standing desk,
 * and the superseded doc still carries rows whose windows are open and whose contribution is still
 * being computed.
 *
 * Refuses a table with a contradictory row (see `stanceCoherence`) — the one thing that must not
 * reach an allocator, and the author can still fix it here.
 */
async function publishTilt(raw, { note = null } = {}) {
    const doc = normalizeTilt(raw)
    if (!doc.tilts.length) return { ok: false, reason: 'no_usable_rows' }

    // A row whose sector will not canonicalise is DROPPED by the normalizer, and the stored doc
    // cannot say so afterwards — "we held no view on Utilities" and "the Utilities row was
    // discarded at the boundary" read identically once written. Record the discrepancy here, the
    // one place both numbers exist, so a silent drop leaves a trace instead of a mystery.
    const emitted = Array.isArray(raw?.tilts) ? raw.tilts.length : 0
    if (emitted > doc.tilts.length) {
        const kept    = new Set(doc.tilts.map(r => r.sector))
        const dropped = (raw.tilts ?? [])
            .map(r => r?.sector)
            .filter(sec => !kept.has(normalizeSector(sec)))
        logger.warn(LOG, 'rows DROPPED — unrecognised sector, not an absent view',
            { emitted, kept: doc.tilts.length, dropped })
    }

    const bad = incoherentRows(doc)
    if (bad.length) {
        const detail = bad.map(b => `${b.sector}: ${b.detail}`).join('; ')
        logger.warn(LOG, 'tilt REJECTED — stance contradicts active weight', { detail })
        return { ok: false, reason: 'stance_contradicts_weight', detail }
    }
    if (!doc.balanced) {
        logger.warn(LOG, 'tilt published UNBALANCED — active weights do not net out', { net_bp: doc.net_bp })
    }

    try {
        const db = await getDb()
        await _ensureIndexes(db)
        // Freeze what each new stance is measured from, BEFORE it is stored — a baseline added later
        // would be a different number than the one the call was actually made at.
        await stampBaselines(doc.tilts, doc.benchmark)
        doc.revisions = [newRevision({ kind: 'publish', note: note ?? `Published ${doc.tilts.length} sector stances` })]
        await db.collection(COLLECTION).updateMany(
            { benchmark: doc.benchmark, status: 'active' },
            { $set: { status: 'superseded', updated_at: doc.updated_at } },
        )
        await db.collection(COLLECTION).insertOne({ ...doc })
        logger.info(LOG, 'tilt published', { id: doc.id, benchmark: doc.benchmark, rows: doc.tilts.length, net_bp: doc.net_bp })
        return { ok: true, doc }
    } catch (err) {
        logger.error(LOG, 'Failed to publish tilt', err)
        return { ok: false, error: err }
    }
}

/**
 * The house view in force right now, or null. This is the read Atlas makes — deliberately a READ
 * rather than a hop, because a standing view is published on a cadence, not requested per run.
 *
 * Null on failure, never a throw: an unreachable strategy view must degrade to "Atlas allocates
 * without a tilt", never to a broken portfolio build.
 */
async function getCurrentTilt(benchmark = 'SPX') {
    try {
        const db = await getDb()
        const doc = await db.collection(COLLECTION)
            .find({ benchmark, status: 'active' }).sort({ created_at: -1 }).limit(1).next()
        if (!doc) return null
        delete doc._id
        return doc
    } catch (err) {
        logger.warn(LOG, 'current tilt read failed (caller unaffected)', err.message)
        return null
    }
}

async function getTiltById(id) {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne({ id })
        if (!doc) return { ok: false, reason: 'not_found' }
        delete doc._id
        return { ok: true, doc }
    } catch (err) {
        logger.error(LOG, 'tilt read failed', err)
        return { ok: false, error: err }
    }
}

/** Published history, newest first — the record the desk is graded on. */
async function listTilts({ benchmark = 'SPX', limit = 24 } = {}) {
    try {
        const db = await getDb()
        return (await db.collection(COLLECTION)
            .find({ benchmark }).sort({ created_at: -1 }).limit(limit).toArray())
            .map(d => { delete d._id; return d })
    } catch (err) {
        logger.error(LOG, 'tilt list failed', err)
        return []
    }
}

/**
 * Patch a stored view in place — the monitor's path (contribution, row maturity, bookkeeping) and
 * small user edits. Appends a revision; never touches identity or `created_at`.
 *
 * A patch that rewrites `tilts` is re-normalised, so a row it carries through with its `set_at`
 * intact keeps its window while a row authored fresh restarts one — the reaffirm-vs-restart rule,
 * inherited rather than re-implemented.
 */
async function updateTilt(id, patch = {}) {
    const found = await getTiltById(id)
    if (!found.ok) return found
    const cur = found.doc

    const p = (patch && typeof patch === 'object') ? patch : {}
    const merged = normalizeTilt({ ...cur, ...p, id: cur.id, created_at: cur.created_at, revisions: cur.revisions })

    if ('tilts' in p) {
        const bad = incoherentRows(merged)
        if (bad.length) {
            const detail = bad.map(b => `${b.sector}: ${b.detail}`).join('; ')
            logger.warn(LOG, 'tilt update REJECTED — stance contradicts active weight', { id, detail })
            return { ok: false, reason: 'stance_contradicts_weight', detail }
        }
    }

    const revision = newRevision({
        kind:    _str(p.revision_kind) ?? 'update',
        note:    _str(p.revision_note),
        changed: diffFields(cur, merged, ['regime', 'tilts', 'status']),
    })

    try {
        const db = await getDb()
        const $set = {
            regime: merged.regime, tilts: merged.tilts, net_bp: merged.net_bp,
            balanced: merged.balanced, status: merged.status, evidence: merged.evidence,
            updated_at: merged.updated_at, revisions: [revision, ..._arr(cur.revisions)],
        }
        const res = await db.collection(COLLECTION).updateOne({ id }, { $set })
        if (!res.matchedCount) return { ok: false, reason: 'not_found' }
        logger.info(LOG, 'tilt updated', { id, kind: revision.kind })
        return { ok: true, doc: { ...merged, revisions: $set.revisions } }
    } catch (err) {
        logger.error(LOG, 'tilt update failed', err)
        return { ok: false, error: err }
    }
}

/** Stand the desk down for this benchmark — a status change, trail kept. */
async function retireTilt(id) {
    return updateTilt(id, { status: 'retired', revision_kind: 'retire', revision_note: 'View retired' })
}
