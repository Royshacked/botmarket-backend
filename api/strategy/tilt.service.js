// Persistence + schema normalizer for the strategy desk's `tilt` — Pythia's standing top-down view.
//
// WHAT A TILT IS. A sector stance expressed the way real equity strategy expresses it: an ACTIVE
// WEIGHT against a benchmark, not an absolute return forecast. "Overweight Healthcare +150bp" says
// healthcare beats the index — it can be right in a falling market. That relativity is what makes it
// gradeable: `active_bp × relative return = contribution`, which is standard attribution rather than
// a judgment call. It is the one forecast in this app that both scores cleanly and drives a decision.
//
// WHY IT IS NOT `coverage`. Coverage is one doc per SYMBOL — bottom-up, per name, house-owned like
// this is. A tilt is ONE doc for the whole market: no symbol at all. Both are BROADCASTS, like the
// Axl brief — one house view serving every user, which Atlas then applies against a particular
// mandate — and neither is ever joined to a user's book. They differ in grain, not in ownership.
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
import { getDb, stripId }  from '../../providers/mongodb.provider.js'
import { makeHouseArtifactRepo } from '../../services/houseArtifact.repo.js'
import { fetchLastPrice }  from '../../services/lastPrice.service.js'
import { logger }          from '../../services/logger.service.js'
import { toNum }           from '../../services/format.util.js'
import { normalizeSector, SECTORS, proxyFor, BENCHMARK_PROXY } from '../../services/entity/vocabulary.js'
import { openWindow, normalizeHorizon, HORIZONS } from '../../services/forecastClock.js'
import { newRevision, diffFields }  from '../../services/revisionTrail.js'

const LOG        = '[tilt]'
// Exported for the tilt monitor, which reads these documents on the background path. One name,
// owned by the service that owns the schema.
export const COLLECTION = 'tilt'
// The write pipe shared with coverage (houseArtifact.repo): the atomic revise, the monitor's
// bookkeeping. The schema, the gates and what counts as a revision stay here.
const _repo = makeHouseArtifactRepo({ collection: COLLECTION })

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

/**
 * What a stance defaults to when it states no horizon — THIS DESK's convention, not the clock
 * module's. `forecastClock.DEFAULT_HORIZON` is `12m`, which is right for a price target (a
 * twelve-month number by definition, and what the Analyst's prompt promises) and wrong for a view
 * re-read every month: a 12m stance reviewed monthly is never graded inside a year. Pythia's prompt
 * has always said `6m`; this is what makes that true rather than aspirational.
 */
export const DESK_HORIZON = '6m'

// ─── pure helpers ─────────────────────────────────────────────────────────────
const _str = v => (typeof v === 'string' && v.trim() ? v.trim() : null)
const _arr = v => (Array.isArray(v) ? v : [])
const _num = toNum   // the one safe coercion — see format.util.toNum
/**
 * The desk's horizon reading, in ONE place because two callers depend on them agreeing: the
 * normalizer stamps a row's window with it, and the reaffirm check compares horizons to decide
 * whether a stance is the same call. If those two ever read an omitted horizon differently, a row
 * Pythia meant to restate is filed as a re-author and silently loses its clock — the exact failure
 * `carryReaffirmed` exists to prevent, arriving one row at a time instead of six.
 */
const _horizon = v => normalizeHorizon(v, DESK_HORIZON)

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

    const { horizon, set_at, ends_at } = openWindow(raw, now, DESK_HORIZON)
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
 * DOES THE TABLE NET OUT — the verdict, not the tolerance. Pure.
 *
 * Its own function because two places need the ANSWER and only one of them stores a document: the
 * normalizer records it on publish, and the desk's draft response carries it so the panel can show
 * the verdict while the view is still being written. The frontend used to reach that verdict itself,
 * with `BALANCE_TOLERANCE_BP` copied into a component — a number that decides a verdict, living in a
 * second repo, where nothing would ever tell you the two had drifted.
 *
 * @param {Array<{active_bp?: number}>} tilts
 * @returns {{ net_bp: number, balanced: boolean }}
 */
export function balanceOf(tilts = []) {
    const sum = (Array.isArray(tilts) ? tilts : []).reduce((acc, t) => acc + (Number(t?.active_bp) || 0), 0)
    return { net_bp: Math.round(sum), balanced: Math.abs(sum) <= BALANCE_TOLERANCE_BP }
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

    return {
        id:        _str(r.id) ?? `tilt_${benchmark}_${randomUUID().slice(0, 8)}`,
        benchmark,
        // NO userId — a house view is a broadcast (see the header).
        regime:    _regime(r.regime),
        tilts,
        ...balanceOf(tilts),
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

/**
 * Is this freshly emitted row the SAME CALL as one already standing? Pure.
 *
 * Reaffirm-vs-re-author has to be decided HERE, because the author cannot decide it: Pythia emits a
 * table, not a diff, and the `<tilt>` block has no `set_at` field — there is no way for it to say
 * "this is the call I made in August". The prompt promises that restating a stance keeps its window
 * and its entry prices; this is what makes the promise true.
 *
 * The equality is deliberately the SAME ONE `diffStances` uses to decide a sector moved, plus the
 * horizon: re-cutting a 12m call to 3m is a different call about the same sector and deserves a
 * deadline it can actually be judged against. Stance, weight and horizon agree → nothing moved.
 */
function _sameCall(raw, held) {
    return (STANCES.includes(raw?.stance) ? raw.stance : null) === (held?.stance ?? null)
        && _num(raw?.active_bp) === _num(held?.active_bp)
        && _horizon(raw?.horizon) === _horizon(held?.horizon)
}

/**
 * Merge the standing view's clock and baseline onto every row that merely RESTATES it. Pure —
 * returns fresh rows, never mutates either side, and is the identity when nothing is standing.
 *
 * WHY THE PUBLISH PATH NEEDS THIS AT ALL. `openWindow` keeps `set_at` only when the row it is given
 * already carries one, and a row off the wire never does — so without this merge every publish
 * re-stamped every clock and `stampBaselines` re-priced every baseline. A monthly review then
 * pushed each deadline out another six months (nothing could ever mature, which is the one trigger
 * the whole clock exists to pull) and re-based the score at the review's own prices, so a stance
 * that had been wrong for six weeks published as flat. Measured on the live book at the time:
 * Energy read +0.99bp against −3.36bp from the baseline it was actually set at.
 *
 * A CLOSED window is never carried. If the held row matured — or its deadline has simply passed —
 * the desk has already been asked for a verdict on it, and restating it is a NEW call rather than
 * the old one continuing. Carrying the dead clock forward would republish a row that is overdue the
 * instant it is stored, and the review it triggers would offer the same row again on every tick.
 */
export function carryReaffirmed(rawTilts, previous, now = new Date().toISOString()) {
    const rows = _arr(rawTilts)
    const held = new Map(_arr(previous?.tilts).filter(r => r?.sector).map(r => [r.sector, r]))
    if (!held.size) return rows

    const nowMs = Date.parse(now)
    return rows.map(raw => {
        if (!raw || typeof raw !== 'object') return raw
        const prev = held.get(normalizeSector(raw.sector))
        if (!prev || !_sameCall(raw, prev)) return raw

        const endsMs = Date.parse(prev.review_date ?? '')
        const open   = prev.state !== 'matured' && Number.isFinite(endsMs) && Number.isFinite(nowMs) && endsMs > nowMs
        if (!open) return raw

        // `??` and not a plain overwrite: a caller that DID supply a window (a repair script, a
        // re-publish of a stored doc) is stating the call's history on purpose, and this is a
        // fallback for the author who cannot state it, not an override of the one who can.
        return {
            ...raw,
            set_at:          raw.set_at          ?? prev.set_at,
            base_px:         raw.base_px         ?? prev.base_px,
            base_bench_px:   raw.base_bench_px   ?? prev.base_bench_px,
            contribution_bp: raw.contribution_bp ?? prev.contribution_bp,
        }
    })
}

/**
 * The document a publish actually stores: the emitted table, with every reaffirmed row's clock and
 * baseline carried over from the view it restates. Pure, and exported because it is the whole of
 * publish that can be tested without a database — the CRUD around it is DB-bound.
 */
export function draftForPublish(raw, previous, now = new Date().toISOString()) {
    const r = (raw && typeof raw === 'object') ? raw : {}
    return normalizeTilt({ ...r, tilts: carryReaffirmed(r.tilts, previous, now) }, now)
}

export const tiltService = { publishTilt, getCurrentTilt, getTiltById, listTilts, updateTilt, retireTilt, recordMonitorState }

/**
 * The monitor's bookkeeping write — the `monitor.*` subtree plus the graded `tilts` array.
 *
 * `updateTilt` is the PUBLICATION path: it appends a revision, which is right for a state change a
 * reader should see (a stance maturing) and wrong for a routine grade refresh — eleven revisions a
 * day would bury the trail that makes the view auditable. The split stays; the write is the shared
 * pipe's (houseArtifact.repo). `set` is a flat map (dotted `monitor.*` paths and/or top-level
 * fields), `inc` the counters.
 */
function recordMonitorState(id, opts) { return _repo.recordMonitorState(id, opts) }
// `DEFAULT_HORIZON` is deliberately NOT re-exported here: it is `12m`, and this desk's default is
// `DESK_HORIZON`. A re-export under the clock module's name would read as this desk's convention
// while stating the other one.
export { HORIZONS, SECTORS }

/** The price read used to stamp a stance's baseline. Injected so tests exercise the stamping. */
const _io = {
    priceFor: async (symbol) => {
        try { return await fetchLastPrice(symbol) } catch { return null }
    },
    // The view a publish is restating, read through the same seam. `getCurrentTilt` already returns
    // null rather than throwing, so an unreachable read degrades to "every row is a fresh call" —
    // exactly what publish did before rows could be carried, never to a failed publish.
    currentView: (benchmark) => getCurrentTilt(benchmark),
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
        const proxy = proxyFor(r.sector)
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
    // What is standing right now, read BEFORE the table is normalised: a reaffirmed row's window and
    // baseline have to be merged onto it while it is still raw, because `openWindow` re-stamps the
    // moment it sees a row without a `set_at`. See carryReaffirmed for what that cost.
    const previous = await _io.currentView(_str(raw?.benchmark) ?? 'SPX')
    const doc = draftForPublish(raw, previous)
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
        // A row whose clock predates this document is one the desk RESTATED. Logged because it is
        // the difference between a desk with a track record and a series of opinions, and because a
        // review that reaffirms nothing is worth noticing rather than inferring later from the data.
        const reaffirmed = doc.tilts.filter(r => r.set_at && r.set_at < doc.created_at).length
        logger.info(LOG, 'tilt published', {
            id: doc.id, benchmark: doc.benchmark, rows: doc.tilts.length, net_bp: doc.net_bp,
            reaffirmed, reauthored: doc.tilts.length - reaffirmed,
        })
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
        return doc ? stripId(doc) : null
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
        return { ok: true, doc: stripId(doc) }
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
            .map(stripId)
    } catch (err) {
        logger.error(LOG, 'tilt list failed', err)
        return []
    }
}

// The fields a patch may write, and the two the table derives whenever its rows change.
const PATCHABLE = ['regime', 'tilts', 'status', 'evidence']

/**
 * The `$set` an update writes: ONLY the fields the patch touched (as normalised), the balance
 * verdict when the rows moved, and `updated_at`. Pure — exported for tests.
 *
 * Not the whole merged document — see coverage.service._updateSet for why: a merged copy is built
 * from a READ, and writing it back whole lands a stale value on any field another writer moved in
 * between. A field the patch did not name is not this write's to touch.
 */
export function _updateSet(patch, merged) {
    const $set = { updated_at: merged.updated_at }
    for (const k of PATCHABLE) if (k in patch) $set[k] = merged[k]
    if ('tilts' in patch) { $set.net_bp = merged.net_bp; $set.balanced = merged.balanced }
    return $set
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
        const res = await _repo.revise(id, _updateSet(p, merged), revision)
        if (!res.ok) return { ok: false, reason: 'not_found' }
        logger.info(LOG, 'tilt updated', { id, kind: revision.kind })
        return { ok: true, doc: { ...merged, revisions: [revision, ..._arr(cur.revisions)] } }
    } catch (err) {
        logger.error(LOG, 'tilt update failed', err)
        return { ok: false, error: err }
    }
}

/** Stand the desk down for this benchmark — a status change, trail kept. */
async function retireTilt(id) {
    return updateTilt(id, { status: 'retired', revision_kind: 'retire', revision_note: 'View retired' })
}
