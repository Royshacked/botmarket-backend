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
import { SECTORS, resolveBucket, parentSector, proxyMeta, BENCHMARK_PROXY } from '../../services/entity/vocabulary.js'
import { openWindow, normalizeHorizon, HORIZONS } from '../../services/forecastClock.js'
import { newRevision, diffFields }  from '../../services/revisionTrail.js'
import { syncCallLedger } from './channelCalls.service.js'

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
 *   • channels         — the regime mapped onto an exposure the bucket's fund has MEASURABLY shown
 *                        (a significant channel beta, get_channel_exposures). rate_sensitivity with
 *                        the exposure measured instead of asserted. Added 2026-09-30.
 *   • evidence         — the industry's own measured evidence carries the row: its companies' beat
 *                        rate and surprise, and its fund's 12-1 momentum (industryReads.service.js;
 *                        IC +0.083 since 2010, +0.115 on tech). The only basis tech can have — no
 *                        channel moves its funds. Added 2026-10-01.
 *   • valuation        — sector multiple vs its own history. Weak mean reversion, non-zero.
 *   • rate_sensitivity — the regime read mapped onto the sector's factor exposure. Top-down.
 */
export const TILT_BASES = ['bottom_up', 'revisions', 'channels', 'evidence', 'valuation', 'rate_sensitivity']

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
 * One stance row, at either grain. Pure. Returns null when it names nothing the vocabulary knows —
 * a bucket that cannot be resolved can be joined neither to market data nor to our own book, so a
 * row keyed on one is not a stance, it is a sentence.
 *
 * `bucket` is read from `bucket`, falling back to the retired `sector` spelling. That fallback is
 * READ-SIDE ONLY — one field is stored, never two — and it exists so a document written before the
 * migration still normalises. Remove it once no stored view carries `sector`.
 *
 * The row owns its OWN clock, and that is the load-bearing detail. A monthly review typically
 * changes two buckets and reaffirms nine; if the clock lived on the document, every review would
 * reset all of them and a 12-month call would never come due — the same unfalsifiability that a
 * price target without a deadline had. `openWindow` preserves `set_at` when the row carries one and
 * re-stamps when it does not, so reaffirming keeps the clock and re-authoring restarts it.
 */
function _row(raw, now) {
    if (!raw || typeof raw !== 'object') return null
    const resolved = resolveBucket(raw.bucket ?? raw.sector)
    if (!resolved) return null
    const { grain, bucket } = resolved

    const { horizon, set_at, ends_at } = openWindow(raw, now, DESK_HORIZON)
    return {
        grain,
        bucket,
        // WHAT THIS ROW IS GRADED AGAINST, frozen at publish beside the baseline and for the same
        // reason. Re-resolving it on every read would mean that swapping a fund in BUCKET_PROXY
        // silently re-scores every stance ever taken on that bucket against an instrument it was
        // never measured on. `weighting` and `exact` ride along because both distort a grade and a
        // reader judging the row needs to see which one it carries.
        proxy: (raw.proxy && typeof raw.proxy === 'object' && _str(raw.proxy.symbol))
            ? { symbol: raw.proxy.symbol, weighting: raw.proxy.weighting ?? null, exact: raw.proxy.exact ?? null }
            : (proxyMeta(bucket) ? { ...proxyMeta(bucket) } : null),
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
        // A SIZED row's arithmetic — which channel calls, through which betas, produced its weight.
        // Kept on the row so the scorecard can later ask whether the bucket moved as the betas said.
        drivers:         _drivers(raw.drivers),
        // A sized row's INDUSTRY-EVIDENCE part: the score and what it added to the expected move.
        evidence:        (raw.evidence && typeof raw.evidence === 'object' && _num(raw.evidence.score) !== null)
            ? { score: _num(raw.evidence.score), contribution: _num(raw.evidence.contribution),
                beat: _num(raw.evidence.beat), surprise: _num(raw.evidence.surprise), momentum: _num(raw.evidence.momentum) }
            : null,
    }
}

function _drivers(raw) {
    const out = _arr(raw)
        .filter(d => d && typeof d === 'object' && _str(d.channel_id))
        .map(d => ({
            channel_id: d.channel_id, beta: _num(d.beta), dz: _num(d.dz), contribution: _num(d.contribution),
            ...(_num(d.deviation) !== null ? { base_dz: _num(d.base_dz), deviation: _num(d.deviation) } : {}),
            ...(_num(d.multiplier) !== null ? { multiplier: _num(d.multiplier) } : {}),
        }))
    return out.length ? out : null
}

function _channelViews(raw) {
    return _arr(raw)
        .filter(v => v && typeof v === 'object' && _str(v.channel_id) && _num(v.dz) !== null)
        .map(v => ({
            channel_id: v.channel_id, dz: _num(v.dz), rationale: _str(v.rationale),
            z_at_set: _num(v.z_at_set), set_at: _str(v.set_at),
            call_id: _str(v.call_id),   // the ledger entry this call is graded under (channelCalls)
            // What the call is MEASURED against: the channel's base rate when it was made, and the
            // deviation that was actually sized. Grading asks whether the deviation was right.
            base_dz: _num(v.base_dz), deviation: _num(v.deviation),
            previous_dz: _num(v.previous_dz),
            flags: _arr(v.flags).filter(f => typeof f === 'string'),
        }))
}

/**
 * Does a row's stance agree with its number? PURE → `{ ok }` | `{ ok: false, bucket, detail }`.
 *
 * This is the bucket-level twin of coverage's `ratingCoherence`, and it exists for the same reason
 * that one does: a `sell` rating with an upside target passed every gate and surfaced a day later as
 * a bogus verdict. Here the failure is worse than bogus — `active_bp` is what Atlas would actually
 * allocate on, so a row reading `stance: 'over'` with `active_bp: -150` would UNDERWEIGHT a bucket
 * the desk meant to favour. The words and the number must agree before either reaches an allocator.
 */
export function stanceCoherence(row) {
    const { bucket, stance, active_bp: bp } = row ?? {}
    if (!stance || bp === null || bp === undefined) return { ok: true }   // nothing claimed → nothing to contradict
    if (stance === 'over' && bp <= 0) {
        return { ok: false, bucket, detail: `an "over" stance needs a positive active weight, got ${bp}bp` }
    }
    if (stance === 'under' && bp >= 0) {
        return { ok: false, bucket, detail: `an "under" stance needs a negative active weight, got ${bp}bp` }
    }
    if (stance === 'neutral' && bp !== 0) {
        return { ok: false, bucket, detail: `a "neutral" stance is 0bp by definition, got ${bp}bp` }
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

    // One row per BUCKET: two stances on one bucket is a contradiction, not a richer view. First
    // wins, so a later duplicate can never quietly override an earlier stance. Keyed on the
    // RESOLVED bucket rather than the spelling, so "semis" cannot sit beside "Semiconductors".
    const seen = new Set()
    const tilts = _arr(r.tilts)
        .map(t => _row(t, now))
        .filter(t => t && !seen.has(t.bucket) && seen.add(t.bucket))

    return {
        id:        _str(r.id) ?? `tilt_${benchmark}_${randomUUID().slice(0, 8)}`,
        benchmark,
        // NO userId — a house view is a broadcast (see the header).
        regime:    _regime(r.regime),
        tilts,
        ...balanceOf(tilts),
        // The desk's MACRO CALLS (step 6, channelSizing.service.js): the channel moves the sized
        // rows were computed from, each stamped with the z it was made at so it can be graded at
        // maturity — "did the channel move as forecast?" is the first question of §6's scorecard.
        channel_views: _channelViews(r.channel_views),
        reactions:     _arr(r.reactions).filter(x => x && typeof x === 'object' && _str(x.bucket) && _str(x.channel_id) && _str(x.reaction)),
        // Buckets the desk kept OUT of the sized table, each with its reason (null when it gave none).
        exclusions:    _arr(r.exclusions).filter(x => x && typeof x === 'object' && _str(x.bucket))
            .map(x => ({ bucket: x.bucket, reason: _str(x.reason) })),
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
 * Rows that DOUBLE-COUNT — an industry sitting under a sector the same table already holds a view
 * on. Pure → `[]` when the table is clean, else `[{ bucket, parent, detail }]`.
 *
 * Every weight here is active against ONE benchmark, which is what keeps the attribution exact. A
 * table holding "Energy −100" and "Oil & Gas Midstream +50" counts midstream's energy exposure
 * twice: the sums still net, and what they mean is mud. Either the view is on the sector or it is
 * on the parts, and the author is the one who knows which.
 *
 * The sibling of `stanceCoherence`, refused in the same place and for the same reason — `active_bp`
 * is what Atlas allocates on, so a number that means two things must not reach it.
 */
export function overlappingRows(doc) {
    const rows    = _arr(doc?.tilts).filter(r => r?.bucket)
    const sectors = new Set(rows.filter(r => r.grain === 'sector').map(r => r.bucket))
    if (!sectors.size) return []

    return rows
        .filter(r => r.grain === 'industry' && sectors.has(parentSector(r.bucket)))
        .map(r => ({
            bucket: r.bucket,
            parent: parentSector(r.bucket),
            detail: `"${r.bucket}" sits inside "${parentSector(r.bucket)}", which this table already holds a view on — hold the sector or its parts, not both`,
        }))
}

/**
 * Rows that cannot be graded at all. Pure — and after the cascade this should be empty forever.
 *
 * `tradableProxy` falls back from a bucket with no fund to its parent's, and every sector has one,
 * so a row reaching here has resolved to something the vocabulary knows and still found nothing.
 * That is a vocabulary bug rather than an authoring mistake, which is why the message points at the
 * table and not at the desk.
 *
 * It used to refuse any table holding an unpriceable bucket, and the prompt said so. That made the
 * desk responsible for knowing which of 155 industries have funds — nothing tells it — so the only
 * safe table was one of sectors. The fallback is the design: name the bucket you mean, and it is
 * graded against the closest instrument that exists, with the row recording which.
 */
export function unpriceableRows(doc) {
    return _arr(doc?.tilts)
        .filter(r => r?.bucket && !r?.proxy?.symbol)
        .map(r => ({ bucket: r.bucket, detail: `"${r.bucket}" resolved but nothing prices it, not even ${parentSector(r.bucket) ?? 'its sector'} — BUCKET_PROXY is missing an entry` }))
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
 *
 * EXCEPT FOR A SIZED ROW, where the weight is the server's arithmetic, not the desk's choice. A row
 * sized from the channel calls and the industry evidence (basis `channels` / `evidence`) moves a few
 * bp whenever any input moves — the same three calls published 40bp rows as 45bp the next review
 * because another fund's row merged (2026-10-01) — and under the strict rule every one restarted its
 * clock, its baseline and its line at every review: the unfalsifiability the carry exists to prevent.
 * So two SIZED rows are the same call when the bucket keeps its DIRECTION and horizon; the new weight
 * is applied to the old window. The desk's own rows keep the strict rule — changing your own weight
 * is re-authoring the call.
 */
const SIZED_BASES = new Set(['channels', 'evidence'])
const _isSized = (row) => SIZED_BASES.has(row?.basis)

function _sameCall(raw, held) {
    const sameStance  = (STANCES.includes(raw?.stance) ? raw.stance : null) === (held?.stance ?? null)
    const sameHorizon = _horizon(raw?.horizon) === _horizon(held?.horizon)
    if (_isSized(raw) && _isSized(held)) return sameStance && sameHorizon
    return sameStance && _num(raw?.active_bp) === _num(held?.active_bp) && sameHorizon
}

/**
 * The held row's running contribution, restated at the NEW weight. Contribution is
 * `active_bp × relative return / 100` (tilt.assess.contributionBp) — linear in the weight — so a
 * reaffirmed sized row whose weight moved carries `old × new / old`, which is what the monitor would
 * compute at its next tick. Unchanged weight → unchanged figure; a held weight of 0 → unknown.
 */
function _carriedContribution(raw, prev) {
    const c = _num(prev?.contribution_bp)
    if (c === null) return null
    const was = _num(prev?.active_bp), now = _num(raw?.active_bp)
    if (now === null || now === was) return c
    if (!was) return null
    return Math.round(c * (now / was) * 100) / 100
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
    const held = new Map(_arr(previous?.tilts)
        .map(r => [resolveBucket(r?.bucket ?? r?.sector)?.bucket, r])
        .filter(([bucket]) => bucket))
    if (!held.size) return rows

    const nowMs = Date.parse(now)
    return rows.map(raw => {
        if (!raw || typeof raw !== 'object') return raw
        const prev = held.get(resolveBucket(raw.bucket ?? raw.sector)?.bucket)
        if (!prev || !_sameCall(raw, prev)) return raw

        const endsMs = Date.parse(prev.review_date ?? '')
        const open   = prev.state !== 'matured' && Number.isFinite(endsMs) && Number.isFinite(nowMs) && endsMs > nowMs
        if (!open) return raw

        // `??` and not a plain overwrite: a caller that DID supply a window (a repair script, a
        // re-publish of a stored doc) is stating the call's history on purpose, and this is a
        // fallback for the author who cannot state it, not an override of the one who can.
        // The FUND rides with the baseline, because the baseline is a price OF that fund. A row off
        // the wire carries no proxy, so without this `_row` re-resolves it from BUCKET_PROXY — and the
        // day a bucket's fund is swapped (XOP → IEO, 2026-09-30) a restated stance would be graded as
        // IEO today against XOP at inception. The same instrument also keys the channel betas
        // (pythia-industries-and-channels.md §4), so a carried row must stay on the fund it began on.
        return {
            ...raw,
            proxy:           raw.proxy           ?? prev.proxy,
            set_at:          raw.set_at          ?? prev.set_at,
            base_px:         raw.base_px         ?? prev.base_px,
            base_bench_px:   raw.base_bench_px   ?? prev.base_bench_px,
            contribution_bp: raw.contribution_bp ?? _carriedContribution(raw, prev),
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
    // The call ledger's sync. Never throws (channelCalls.syncCallLedger) — a ledger failure must not
    // cost the publish.
    syncCalls: (doc) => syncCallLedger(doc),
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
        // The row's OWN proxy, stamped by `_row` and never re-resolved here: a stance is
        // measured against the instrument it was published against, whatever the table says later.
        const proxy = r.proxy?.symbol ?? null
        if (r.base_px === null && proxy)      r.base_px = _num(await io.priceFor(proxy))
        if (r.base_bench_px === null)         r.base_bench_px = benchPx
    }
    const unpriced = rows.filter(r => r.base_px === null || r.base_bench_px === null).map(r => r.bucket)
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

    // A row naming nothing the vocabulary knows is DROPPED by the normalizer, and the stored doc
    // cannot say so afterwards — "we held no view on Utilities" and "the Utilities row was
    // discarded at the boundary" read identically once written. Record the discrepancy here, the
    // one place both numbers exist, so a silent drop leaves a trace instead of a mystery.
    const emitted = Array.isArray(raw?.tilts) ? raw.tilts.length : 0
    if (emitted > doc.tilts.length) {
        const kept    = new Set(doc.tilts.map(r => r.bucket))
        const dropped = (raw.tilts ?? [])
            .map(r => r?.bucket ?? r?.sector)
            .filter(name => !kept.has(resolveBucket(name)?.bucket))
        logger.warn(LOG, 'rows DROPPED — unrecognised bucket, not an absent view',
            { emitted, kept: doc.tilts.length, dropped })
    }

    const bad = incoherentRows(doc)
    if (bad.length) {
        const detail = bad.map(b => `${b.bucket}: ${b.detail}`).join('; ')
        logger.warn(LOG, 'tilt REJECTED — stance contradicts active weight', { detail })
        return { ok: false, reason: 'stance_contradicts_weight', detail }
    }

    // Both of these are permanent conditions the author can fix, so they are refused here rather
    // than recorded — unlike an unbalanced table, which is a smell worth seeing and not worth
    // destroying the work over.
    const overlapping = overlappingRows(doc)
    if (overlapping.length) {
        const detail = overlapping.map(o => o.detail).join('; ')
        logger.warn(LOG, 'tilt REJECTED — a table cannot hold a sector and its own parts', { detail })
        return { ok: false, reason: 'bucket_overlaps_parent', detail }
    }

    const unpriceable = unpriceableRows(doc)
    if (unpriceable.length) {
        const detail = unpriceable.map(u => u.detail).join('; ')
        logger.warn(LOG, 'tilt REJECTED — a stance that cannot be priced can never be graded', { detail })
        return { ok: false, reason: 'bucket_has_no_proxy', detail }
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
        // The CALL LEDGER: each channel call gets its own clock, so a restated call keeps the date,
        // reading and base rate it was made at and can be graded at six months (channelCalls).
        if (doc.channel_views?.length) await _io.syncCalls(doc)
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
            const detail = bad.map(b => `${b.bucket}: ${b.detail}`).join('; ')
            logger.warn(LOG, 'tilt update REJECTED — stance contradicts active weight', { id, detail })
            return { ok: false, reason: 'stance_contradicts_weight', detail }
        }
        // The same gate publish applies, and for the same reason: this path is how the monitor and
        // a hand correction rewrite rows, and either could introduce the overlap a publish refuses.
        const overlapping = overlappingRows(merged)
        if (overlapping.length) {
            const detail = overlapping.map(o => o.detail).join('; ')
            logger.warn(LOG, 'tilt update REJECTED — a table cannot hold a sector and its own parts', { id, detail })
            return { ok: false, reason: 'bucket_overlaps_parent', detail }
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
