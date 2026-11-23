// Persistence for the house `coverage` — the living per-name research thesis.
// One document per symbol in the `coverage` collection: identity + the variant-perception
// thesis + our price target vs the Street (the GAP = the edge) + monitorable kill-criteria
// + an append-only `revisions[]` history (the "living" part).
//
// HOUSE-OWNED. Coverage is a broadcast artifact — no userId, one thesis per symbol,
// authored by Prometheus (admin pipeline) and read by every desk. It mirrors the tilt's
// ownership model: one active view per name, superseded on revision, owner-blind.
//
// This module owns persistence + the schema normalizer. It is NOT part of the execution-tier
// `entities` collection — coverage is a research artifact, monitored by its own coverage-monitor,
// never by an execution-tier monitor.

import { randomUUID }      from 'crypto'
import { getDb, stripId }  from '../../providers/mongodb.provider.js'
import { makeHouseArtifactRepo } from '../../services/houseArtifact.repo.js'
import { fetchLastPrice }  from '../../services/lastPrice.service.js'
import { logger }          from '../../services/logger.service.js'
import { cleanConviction } from '../../services/conviction.util.js'
import { toNum }           from '../../services/format.util.js'
import { HORIZONS, DEFAULT_HORIZON, openWindow, normalizeHorizon } from '../../services/forecastClock.js'
import { ratingBand, stickyBand, RERATE_KIND } from '../../services/ratingBands.js'
import { normalizeSector, normalizeIndustry }  from '../../services/entity/vocabulary.js'
import { newRevision, diffFields } from '../../services/revisionTrail.js'
import { perShare } from '../../services/corporateActions.service.js'

const LOG = '[coverage]'
export const COLLECTION = 'coverage'
// The write pipe shared with the tilt (houseArtifact.repo): the atomic revise, the monitor's
// bookkeeping. The schema, the gates and what counts as a revision stay here.
const _repo = makeHouseArtifactRepo({ collection: COLLECTION })

// ─── vocabulary ───────────────────────────────────────────────────────────────

export const RATINGS  = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell']
export { HORIZONS, DEFAULT_HORIZON }

// Lifecycle — active = live thesis; target_hit / thesis_broken = terminal-but-kept;
// retired = churned out of the book; watchlist = proposed but not yet initiated.
export const STATUSES = ['active', 'thesis_broken', 'target_hit', 'retired', 'watchlist']
const DEFAULT_STATUS = 'active'

// Selection schools Prometheus tags at research time and updates on re-model.
// Atlas uses these for the mandate-build DB filter; it still applies school judgment
// over the thesis — the tag is a pre-filter, not a cage.
export const SCHOOLS = ['quality-value', 'growth-durability', 'income', 'passive']

const PLAN_FIELDS = ['sector', 'thesis', 'rating', 'price_target', 'estimates', 'gap',
    'catalysts', 'kill_criteria', 'risk_reward', 'conviction', 'status', 'evidence', 'flags', 'schools']

export const coverageService = {
    initiateCoverage,
    queueRevision,
    getCoverage,
    getCoverageBySymbol,
    getCoverageById,
    listSymbols,
    listActiveBySector,
    updateCoverage,
    setHorizonView,
    retireCoverage,
    deleteCoverage,
    captureResearchBasis,
    recordMonitorState,
    claimRemodel,
    rerateCoverage,
    applySplit,
}

/**
 * RE-RATE live coverage by the house's bands (Roy, 2026-10-28: the bands apply on a save, so a name kept its old
 * rating until its next re-model — a +30% "hold" beside a +5% one). Its own target, price and horizon → the band's
 * rating, written with a `RERATE_KIND` revision that says why. The target and the thesis are untouched, and it is NOT a
 * call: the scorecard neither logs it (no _logCall) nor rebuilds one from the trail (prometheusCalls.backfill). →
 * `{ ok, outcome: 'rerated' | 'same' | 'no_price' | 'no_target', from?, to?, band? }`; `dry` reads and writes nothing.
 */
async function rerateCoverage(id, { dry = false, io = _io, price = null } = {}) {
    const found = await getCoverageById(id)
    if (!found.ok) return found
    const cur = found.doc
    if (_num(cur?.price_target?.value) === null) return { ok: true, outcome: 'no_target', symbol: cur.symbol }
    // `price` — today's, when the caller (the coverage monitor's daily tick, 2026-11-21) has already read it. The target's
    // reference (withTargetRef) is NOT touched: only the label follows the price. Held near an edge (stickyBand): a label
    // following the price must not flip on a day's noise.
    const house = await _houseRating(cur, io, { price, sticky: true })
    if (!house) return { ok: true, outcome: 'no_price', symbol: cur.symbol }
    if (house.from === undefined) return { ok: true, outcome: 'same', symbol: cur.symbol, rating: cur.rating }
    const out = { ok: true, outcome: 'rerated', symbol: cur.symbol, from: cur.rating ?? null, to: house.band.rating, band: house.band }
    if (dry) return out
    const revision = newRevision({ kind: RERATE_KIND, note: houseRatingNote(house), changed: { rating: { from: cur.rating ?? null, to: house.band.rating } } })
    try {
        const res = await _repo.revise(id, { rating: house.band.rating, updated_at: new Date().toISOString() }, revision)
        if (!res.ok) return { ok: false, reason: 'not_found' }
        logger.info(LOG, 'coverage re-rated by the house bands', { id, symbol: cur.symbol, from: out.from, to: out.to })
        return out
    } catch (err) {
        logger.error(LOG, 'coverage re-rate failed', err)
        return { ok: false, error: err }
    }
}

// ─── stock splits (2026-11-22, services/corporateActions) ───────────────────

/** The revision kind of a split restated by the house — mechanical, not a call of Prometheus's. */
export const SPLIT_KIND = 'split_adjust'
/**
 * Is an estimate's KEY a per-share amount? Its words (split on `_`): it starts with eps / dps / bvps / fcfps, or ends
 * `per_share` — and names no rate (`eps_growth_pct`, `eps_cagr`, `eps_yoy`… stay). The estimates are free-form model
 * output, so a key is read word by word, never by a substring (code review, 2026-11-22). Pure.
 */
export function perShareKey(key) {
    const w = String(key ?? '').toLowerCase().split(/[_\s-]+/).filter(Boolean)
    if (!w.length) return false
    if (w.some(x => /^(pct|percent|growth|cagr|yoy|qoq|rate|ratio|margin|payout|yield|surprise|revisions?|count|beats?|misses?)$/.test(x))) return false
    return /^(eps|dps|bvps|fcfps)$/.test(w[0]) || (w.at(-2) === 'per' && w.at(-1) === 'share')
}

/** Every per-share number under an estimates object, nested too (`fy2026: { eps }`) → [path, value]. Pure. */
function _perShareEstimates(obj, base, inPerShare = false, depth = 0) {
    const out = []
    if (!obj || typeof obj !== 'object' || depth > 3) return out
    for (const [k, v] of Object.entries(obj)) {
        const path = `${base}.${k}`
        const ps = perShareKey(k)
        if (v && typeof v === 'object' && !Array.isArray(v)) out.push(..._perShareEstimates(v, path, ps || inPerShare, depth + 1))
        else if ((ps || (inPerShare && /^(fy\d*|q\d|low|high|mean|median|value|ntm|ttm)$/i.test(k))) && v != null && Number.isFinite(Number(v))) out.push([path, v])
    }
    return out
}

/**
 * A coverage's PER-SHARE numbers after a split → the `$set` (dotted paths), the target's clock untouched. The target
 * (value, low, high, ref_price), the scenario legs (value and their per-share forward metric — EPS; the multiple stays),
 * the per-share estimates (`eps…`, `…per_share`, `dps…`), the recorded gap, and the horizon views' targets. A percentage
 * (σ, a gap's %) is not per-share. The prose — thesis, kill criteria — cannot be restated: the re-model does it. Pure.
 */
export function splitAdjustment(doc, ratio) {
    const set = {}
    const put = (path, v) => { if (v != null && Number.isFinite(Number(v))) set[path] = perShare(v, ratio) }
    for (const k of ['value', 'low', 'high', 'ref_price']) put(`price_target.${k}`, doc?.price_target?.[k])
    for (const leg of ['bear', 'base', 'bull']) {
        const l = doc?.risk_reward?.[leg]
        if (l && typeof l === 'object') {
            put(`risk_reward.${leg}.value`, l.value)
            // The forward metric only when it IS per share — the multiple × it is the leg's price (P/E on EPS). An EV/sales
            // leg's metric is revenue, which a split does not touch.
            if (_looksLikePE(l)) put(`risk_reward.${leg}.forward_metric`, l.forward_metric)
        } else put(`risk_reward.${leg}`, l)
    }
    for (const side of ['ours', 'consensus']) for (const [path, v] of _perShareEstimates(doc?.estimates?.[side], `estimates.${side}`)) put(path, v)
    for (const k of ['our_pt', 'consensus_pt', 'low', 'high', 'median']) put(`gap.${k}`, doc?.gap?.[k])
    for (const [book, view] of Object.entries(doc?.horizon_views ?? {})) {
        for (const k of ['value', 'low', 'high']) put(`horizon_views.${book}.target.${k}`, view?.target?.[k])
        put(`horizon_views.${book}.price_at_set`, view?.price_at_set)
    }
    return set
}

/**
 * RESTATE a coverage for a split (the coverage monitor, the day it sees one): every per-share number ÷ the ratio, with a
 * SPLIT_KIND revision that says so; its open scorecard calls the same (prometheusCalls.adjustCallsForSplit); then a
 * re-model queued (`monitor.pending_revision`, state 'split'), since the prose still speaks in pre-split dollars.
 * `monitor.split_through` records the split so it is applied once. → `{ ok, outcome: 'restated', doc, calls }` |
 * `{ ok: true, outcome: 'done_already' }` | `{ ok: false, … }`.
 */
async function applySplit(id, split, { calls = null } = {}) {
    const found = await getCoverageById(id)
    if (!found.ok) return found
    const cur = found.doc
    const ratio = Number(split?.ratio)
    if (!(ratio > 0) || !split?.date) return { ok: false, reason: 'bad_split' }
    if (cur.monitor?.split_through && cur.monitor.split_through >= split.date) return { ok: true, outcome: 'done_already' }
    const set = splitAdjustment(cur, ratio)
    const words = `${split.numerator}-for-${split.denominator}`
    const pt = cur.price_target?.value
    const note = `${cur.symbol} split ${words} on ${split.date}: every per-share number restated ÷ ${Math.round(ratio * 1000) / 1000}`
        + (pt != null ? ` (target ${pt} → ${set['price_target.value']})` : '') + '. The thesis text is pre-split — a re-model restates it.'
    const at = new Date().toISOString()
    try {
        // ONE conditional write — the numbers and the stamp together, and only while the stamp is still before this split:
        // a restate written without its stamp would be divided again by the next check, and a second process racing this
        // one finds the condition gone (→ done_already).
        const res = await _repo.revise(id, {
            ...set, updated_at: at,
            'monitor.split_through': split.date,
            'monitor.pending_revision': { state: 'split', reason: `${words} split on ${split.date}`, at },
        }, newRevision({ kind: SPLIT_KIND, note, changed: pt != null ? { price_target: { from: pt, to: set['price_target.value'] } } : {} }), {
            where: { $or: [{ 'monitor.split_through': { $exists: false } }, { 'monitor.split_through': { $lt: split.date } }] },
        })
        if (!res.ok) return { ok: true, outcome: 'done_already' }
        const restated = await (calls ?? (async (a) => (await import('../../services/prometheusCalls.service.js')).prometheusCallsService.adjustCallsForSplit(a)))({ coverageId: id, symbol: cur.symbol, split })
        logger.info(LOG, 'coverage restated for a split', { id, symbol: cur.symbol, date: split.date, ratio, calls: restated })
        const after = await getCoverageById(id)
        return { ok: true, outcome: 'restated', doc: after.ok ? after.doc : null, calls: restated }
    } catch (err) {
        logger.error(LOG, 'split restate failed', err)
        return { ok: false, error: err }
    }
}

// ─── monitor.* namespace ─────────────────────────────────────────────────────

/**
 * QUEUE A RE-MODEL from outside the monitor's own verdicts (2026-11-22: the industry strategist's stance on the name's book
 * changed — services/industryVerdictCoverage). `monitor.pending_revision` is set (coverage.remodel REVISE_STATES reads
 * it) and the next check brought forward to now, so the hourly loop picks it up. Only when nothing is waiting already —
 * a queued target hit or split is answered by the same run, and keeps its own reason — and never on a retired name.
 * → true when queued.
 */
async function queueRevision(id, { state, reason = null, at = new Date().toISOString() } = {}) {
    const db = await getDb()
    const res = await db.collection(COLLECTION).updateOne(
        { id, status: { $ne: 'retired' }, 'monitor.pending_revision': { $in: [null] } },
        { $set: { 'monitor.pending_revision': { state, reason, at }, 'monitor.next_check_at': at } },
    )
    return res.modifiedCount === 1
}

/** The monitor's bookkeeping under `monitor.*` — no revision. See houseArtifact.repo. */
function recordMonitorState(id, opts) { return _repo.recordMonitorState(id, opts) }

async function claimRemodel(id, { previousAt = null, reason, at = new Date().toISOString() } = {}) {
    const db  = await getDb()
    const res = await db.collection(COLLECTION).updateOne(
        { id, 'monitor.last_remodel_at': previousAt ?? null },
        {
            $set:   { 'monitor.last_remodel_at': at, 'monitor.last_remodel_reason': reason },
            $inc:   { 'monitor.remodels': 1 },
            // The run that claims the name answers the verdict waiting on it (coverage.remodel).
            $unset: { 'monitor.pending_revision': '' },
        },
    )
    return res.modifiedCount === 1
}

export { normalizeCoverage, newRevision }

// ─── coherence + plausibility gates ──────────────────────────────────────────

const BULLISH_RATINGS = new Set(['strong_buy', 'buy'])
const BEARISH_RATINGS = new Set(['sell', 'strong_sell'])

export function ratingCoherence({ rating, price_target, price } = {}) {
    const pt = _num(price_target?.value ?? price_target)
    const px = _num(price)
    const bullish = BULLISH_RATINGS.has(rating), bearish = BEARISH_RATINGS.has(rating)
    if ((!bullish && !bearish) || pt === null || px === null || px <= 0) return { ok: true }

    const impliedPct = Math.round((pt - px) / px * 1000) / 10
    if (bullish && pt <= px) {
        return { ok: false, reason: 'rating_contradicts_target', detail:
            `A ${rating} rating needs upside, but the target ${pt} is at or below the price ${px} (${impliedPct}%). `
            + `Either the target is too low or the rating should be hold/sell — a gap vs the Street is not a rating.` }
    }
    if (bearish && pt >= px) {
        return { ok: false, reason: 'rating_contradicts_target', detail:
            `A ${rating} rating needs downside, but the target ${pt} is at or above the price ${px} (+${impliedPct}%). `
            + `Being below the Street's consensus is a view on the consensus, not on the stock — rate the stock.` }
    }
    return { ok: true }
}

const BAND_CEILING = { high: 4, medium: 8, low: Infinity }

export function bandConviction({ risk_reward, conviction } = {}) {
    const bear = _num(risk_reward?.bear?.value), bull = _num(risk_reward?.bull?.value)
    const level = conviction?.level
    const ceiling = BAND_CEILING[level]
    if (!ceiling || bear === null || bull === null || bear <= 0 || bull <= 0) return { ok: true }

    const ratio  = bull / bear
    const spread = Math.round(ratio * 10) / 10
    if (ratio <= ceiling) return { ok: true }
    return { ok: false, reason: 'band_contradicts_conviction', spread, detail:
        `The bear/bull band spans ${bear}–${bull} — a ${spread}x spread — while conviction is \`${level}\` `
        + `(a ${level} call carries at most ${ceiling}x). A band that wide is a statement that the outcome `
        + `is unknown; pick one, and if the band is right the conviction should come down.` }
}

const _looksLikePE = leg => {
    const v = _num(leg?.value), m = _num(leg?.multiple), f = _num(leg?.forward_metric)
    return v !== null && m !== null && f !== null && v > 0 && Math.abs(m * f - v) / v < 0.02
}
const MIN_MULTIPLE_HISTORY = 5

export function multipleStretch({ multiple, history, leg = 'base' } = {}) {
    const m = _num(multiple)
    const obs = (Array.isArray(history) ? history : []).map(_num).filter(x => x !== null && x > 0).sort((a, b) => a - b)
    if (m === null || m <= 0 || obs.length < MIN_MULTIPLE_HISTORY) return { ok: true, pctile: null }

    const r1 = x => Math.round(x * 10) / 10
    const min = r1(obs[0]), max = r1(obs[obs.length - 1])
    const pctile = Math.round(obs.filter(x => x < m).length / obs.length * 100)
    if (m >= obs[0] && m <= obs[obs.length - 1]) return { ok: true, pctile }

    const below = m < obs[0]
    return { ok: false, reason: 'multiple_outside_history', pctile, min, max, below, detail:
        `The ${leg} leg applies a ${m}x multiple — ${below ? 'BELOW' : 'ABOVE'} the entire range this name `
        + `has traded at over ${obs.length} years (${min}x–${max}x). ${below
            ? 'A trough the market has never actually paid is an assumption, not a downside case'
            : 'A peak the market has never actually paid is an assumption, not an upside case'} — `
        + `say what re-rates it there, or move the leg inside the range.` }
}

const _io = {
    getPrice: async (symbol) => {
        try { return await fetchLastPrice(symbol) } catch { return null }
    },
    // The stock's σ over a target's horizon, % — the rating bands' margin (2026-11-21). Proteus's profile, the one
    // shared read; null (the flat margin) when there is none. Lazy so a test can stub it without the candle stack.
    getSigma: async (symbol, horizon) => {
        try {
            const { horizonSigma } = await import('../../services/stockProfile.service.js')
            return await horizonSigma(symbol, horizon)
        } catch { return null }
    },
    getMultipleHistory: async (symbol) => {
        try {
            const { getHistoricalMultiples } = await import('../../providers/fmp.provider.js')
            return await getHistoricalMultiples(symbol, 'pe')
        } catch { return [] }
    },
    // The taxonomy read — see _withTaxonomy. Lazy like its neighbour above so a test can stub it
    // without the provider stack loading.
    sectorRaw: async (symbol) => {
        const { getSectorRaw } = await import('../../providers/fmp.provider.js')
        return getSectorRaw(symbol)
    },
}
export function _setCoverageIO(io) { Object.assign(_io, io) }

/**
 * THE HOUSE'S RATING (2026-10-28, services/ratingBands): the band the price target falls in against SPY over its
 * horizon → `{ band, from }` (`from` — the rating Prometheus wrote, when the band differs), or null when there is no
 * target or no price (his rating stands then). The rating is the BAND, not a direction he picks: before it his holds
 * ran from −30% to +37% at the call. It replaces the old direction check (ratingCoherence), which a band never fails.
 *
 * Since 2026-11-21 the margin is in the stock's own σ over the horizon and a LOW conviction caps a strong rating
 * (ratingBands). `price` — the price the band was read at (a caller that already has today's, the monitor, passes it).
 * `sticky` — a re-rate of the label already on the doc: held there near an edge (ratingBands.stickyBand, 2026-11-22).
 * → `{ band, from, price }`.
 */
async function _houseRating(doc, io = _io, { price = null, sticky = false } = {}) {
    if (_num(doc?.price_target?.value) === null) return null
    const px = _num(price) ?? _num(await io.getPrice(doc.symbol))
    if (!(px > 0)) return null
    const sigma = _num(await Promise.resolve(io.getSigma?.(doc.symbol, doc.price_target.horizon)).catch(() => null))
    const conviction = doc.conviction?.level ?? null
    let band = ratingBand({ target: doc.price_target.value, price: px, horizon: doc.price_target.horizon, sigma_pct: sigma, conviction })
    if (!band) return null
    if (sticky) band = stickyBand(band, doc.rating, { conviction })
    return { band, price: px, from: band.rating !== doc.rating ? (doc.rating ?? null) : undefined }
}

/**
 * The target's REFERENCE — the price and σ its band was first read at, kept on the target (`ref_price`, `sigma_pct`):
 * which way the target points is a fact about the day it was set, not about today's price. A daily re-rate moves the
 * rating with the price; it must not move which side of the price the target is on (coverage.assess reads this for a
 * hit). A reaffirmed target (keepClock — the same `set_at`) keeps its reference. A draft's own `ref_price` / `sigma_pct`
 * is never taken (code review, 2026-11-22): a new target without a price read has no reference (the rating's way). Pure.
 */
export function withTargetRef(next, cur, house) {
    if (!next) return next
    const { ref_price: _draftRef, sigma_pct: _draftSigma, ...bare } = next
    if (cur?.set_at && next.set_at === cur.set_at && _num(cur.ref_price) !== null) {
        return { ...bare, ref_price: cur.ref_price, ...(cur.sigma_pct != null ? { sigma_pct: cur.sigma_pct } : {}) }
    }
    if (!house) return bare
    return { ...bare, ref_price: Math.round(house.price * 100) / 100, ...(house.band.sigma_pct != null ? { sigma_pct: house.band.sigma_pct } : {}) }
}

/** What a re-rating says on the revision. Pure. */
export function houseRatingNote({ band, from } = {}) {
    if (!band || from === undefined) return null
    const sigma = band.basis === 'sigma' ? `, a margin of ${band.margin_pct}% (0.25σ of the stock's ${band.sigma_pct}%)` : ''
    const cap = band.capped ? ', capped by low conviction' : ''
    return `Rated ${band.rating.replace('_', ' ')} by the house bands: the target is ${band.implied_pct > 0 ? '+' : ''}${band.implied_pct}% against SPY's ~+${band.market_pct}% over ${band.horizon}${sigma}${cap} (${from ? `${from.replace('_', ' ')} given` : 'no rating given'})`
}

export async function _plausibilityFlags(doc, io = _io) {
    const flags = []
    try {
        const band = bandConviction(doc)
        if (!band.ok) flags.push({ code: band.reason, leg: null, detail: band.detail })

        const legs = ['bear', 'base', 'bull']
            .map(name => ({ name, leg: doc?.risk_reward?.[name] }))
            .filter(({ leg }) => _looksLikePE(leg))
        if (legs.length) {
            const history = await io.getMultipleHistory(doc.symbol)
            const judged = legs.map(({ name, leg }) => ({ name, s: multipleStretch({ multiple: leg.multiple, history, leg: name }) }))
            const missed = judged.filter(({ s }) => !s.ok)

            const wholesale = judged.length > 1 && missed.length === judged.length
                && new Set(missed.map(({ s }) => s.below)).size === 1
            if (wholesale) {
                logger.info(LOG, 'multiple history skipped — every leg offset the same way, reading as a metric mismatch',
                    { symbol: doc.symbol, ours: judged.map(({ s }) => s.pctile === 0 ? 'below' : 'above')[0], range: `${missed[0].s.min}-${missed[0].s.max}x` })
            } else {
                for (const { name, s } of missed) flags.push({ code: s.reason, leg: name, detail: s.detail })
            }
        }
    } catch (err) {
        logger.warn(LOG, 'plausibility flags failed (thesis unaffected)', err.message)
    }
    return flags
}

// ─── pure helpers ─────────────────────────────────────────────────────────────
const _str = v => (typeof v === 'string' && v.trim() ? v.trim() : null)
const _arr = v => (Array.isArray(v) ? v : [])
const _num = toNum

function _priceTarget(pt, now) {
    if (!pt || typeof pt !== 'object') return null
    const value = _num(pt.value)
    if (value === null) return null
    const { horizon, set_at, ends_at } = openWindow(pt, now)
    // A target with NO horizon of its own stores as the house's 12m — and says so (2026-10-28): 84% of the book sat on
    // 12m and nothing told a chosen one from a default. Marked, not refused: a refused save strands an automatic run's name.
    // A stored target keeps its mark when it is normalised again (an update merges it); a new one with a horizon clears it.
    const defaulted = !HORIZONS.includes(pt.horizon) || pt.horizon_defaulted === true
    // The reference the band was read at (withTargetRef) rides along through a re-normalise; never from a draft's own say.
    const ref = _num(pt.ref_price), sig = _num(pt.sigma_pct)
    return {
        value, horizon, basis: _str(pt.basis), set_at, target_date: ends_at, ...(defaulted ? { horizon_defaulted: true } : {}),
        ...(ref > 0 ? { ref_price: ref } : {}), ...(sig > 0 ? { sigma_pct: sig } : {}),
    }
}

function _gap(g) {
    if (!g || typeof g !== 'object') return null
    const our_pt = _num(g.our_pt), consensus_pt = _num(g.consensus_pt), pct = _num(g.pct)
    const low = _num(g.low), high = _num(g.high), median = _num(g.median), pctile = _num(g.pctile)
    if (our_pt === null && consensus_pt === null && pct === null && low === null && high === null) return null
    return { our_pt, consensus_pt, pct, low, high, median, pctile }
}

function _leg(v) {
    if (v === null || v === undefined) return null
    if (typeof v === 'object' && !Array.isArray(v)) {
        const value = _num(v.value)
        return value === null ? null : { value, multiple: _num(v.multiple), forward_metric: _num(v.forward_metric) }
    }
    const value = _num(v)
    return value === null ? null : { value, multiple: null, forward_metric: null }
}

function _riskReward(rr) {
    if (!rr || typeof rr !== 'object') return null
    const bull = _leg(rr.bull), base = _leg(rr.base), bear = _leg(rr.bear)
    if (bull === null && base === null && bear === null) return null

    const vals = [bear?.value, base?.value, bull?.value]
    const ordered = vals.every(v => v !== null && v !== undefined)
        ? (vals[0] < vals[1] && vals[1] < vals[2])
        : true

    return {
        bear, base, bull,
        band_basis: ['scenario', 'multiple_sensitivity'].includes(rr.band_basis) ? rr.band_basis : null,
        ordered,
    }
}

const FLAG_CODES = new Set(['band_contradicts_conviction', 'multiple_outside_history'])
const _flags = v => _arr(v)
    .filter(f => f && typeof f === 'object' && FLAG_CODES.has(f.code))
    .map(f => ({ code: f.code, leg: _str(f.leg), detail: _str(f.detail) }))

// Schools: Prometheus tags which selection schools this name fits. Atlas uses this
// as a pre-filter on mandate-build; it re-evaluates fit from the thesis at allocation time.
const _schools = v => _arr(v).filter(s => SCHOOLS.includes(s))

function normalizeCoverage(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {}
    const symbol = (typeof r.symbol === 'string' ? r.symbol : '').toUpperCase().trim()
    const now = new Date().toISOString()
    return {
        id:            _str(r.id) ?? `cov_${symbol || 'x'}_${randomUUID().slice(0, 8)}`,
        symbol,
        sector:        normalizeSector(r.sector),
        // THE GRAIN BELOW THE SECTOR, and the one Pythia's bottom-up cross-check needs to say
        // anything finer than "Technology". Normalised through the same vocabulary the strategy
        // desk holds its stances in, so `bottom_up` on an industry row means our covered names in
        // THAT industry rather than in its sector.
        industry:      normalizeIndustry(r.industry),
        thesis:        _str(r.thesis),
        rating:        RATINGS.includes(r.rating) ? r.rating : null,
        price_target:  _priceTarget(r.price_target, now),
        estimates:     (r.estimates && typeof r.estimates === 'object' && !Array.isArray(r.estimates)) ? r.estimates : {},
        gap:           _gap(r.gap),
        catalysts:     _arr(r.catalysts),
        kill_criteria: _arr(r.kill_criteria),
        risk_reward:   _riskReward(r.risk_reward),
        conviction:    cleanConviction(r.conviction),
        schools:       _schools(r.schools),
        flags:         _flags(r.flags),
        status:        STATUSES.includes(r.status) ? r.status : DEFAULT_STATUS,
        revisions:     _arr(r.revisions),
        evidence:      _arr(r.evidence),
        monitor:       (r.monitor && typeof r.monitor === 'object' && !Array.isArray(r.monitor))
            ? r.monitor : { next_check_at: null, last_checked: null, checks: 0 },
        created_at:    _str(r.created_at) ?? now,
        updated_at:    now,
    }
}

async function _ensureIndexes(db) {
    await db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true })
    // If a non-unique symbol index was created before this constraint was added,
    // MongoDB raises IndexOptionsConflict (code 85). Drop the old index and recreate.
    // (The recreate would also fail on duplicate symbols. None can exist once this index
    // is in place, and the one-off cleanup that preceded it was removed on 2026-09-16 —
    // a collection that somehow has duplicates again needs a hand, not a route.)
    try {
        await db.collection(COLLECTION).createIndex({ symbol: 1 }, { unique: true })
    } catch (err) {
        if (err.code === 85) {
            logger.warn(LOG, '_ensureIndexes: replacing non-unique symbol index with unique one')
            await db.collection(COLLECTION).dropIndex('symbol_1')
            await db.collection(COLLECTION).createIndex({ symbol: 1 }, { unique: true })
        } else {
            throw err
        }
    }
    await db.collection(COLLECTION).createIndex({ sector: 1, status: 1, schools: 1 })
}

/**
 * Fill the sector and industry from the PROVIDER, not from the model. Returns a new document.
 *
 * Prometheus emits `sector` in its `<coverage>` block, and the fundamentals it reads formats the
 * pair as "Technology / Software - Infrastructure" (see fmp.provider's profile lines) — so three
 * documents on the book stored that whole string as their sector and were invisible to every
 * `$in` match against the eleven until `repair-coverage-sectors.mjs` cleaned them. A taxonomy
 * transcribed by a model is a taxonomy that drifts; this one is looked up.
 *
 * The model's own value is kept as the FALLBACK, for the case the provider does not know the
 * ticker at all (an ETF, a foreign listing) — a thesis is worth more than its metadata, and losing
 * the sector would drop the name out of the cross-check entirely.
 */
async function _withTaxonomy(doc, symbol, io = _io) {
    try {
        const raw = await io.sectorRaw(symbol)
        if (!raw) return doc
        return {
            ...doc,
            sector:   normalizeSector(raw.sector) ?? doc.sector,
            industry: normalizeIndustry(raw.industry) ?? doc.industry,
        }
    } catch (err) {
        // The taxonomy is an attribute of a thesis, never a precondition for storing one.
        logger.warn(LOG, `taxonomy lookup failed for ${symbol} — keeping what was emitted`, err.message)
        return doc
    }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

async function initiateCoverage(raw) {
    const symbol = (typeof raw?.symbol === 'string' ? raw.symbol : '').toUpperCase().trim()
    if (!symbol) return { ok: false, reason: 'symbol_required' }
    try {
        const db = await getDb()
        await _ensureIndexes(db)
        const existing = await db.collection(COLLECTION).findOne({ symbol })
        if (existing) return { ok: false, reason: 'already_covered', id: existing.id }

        const doc = await _withTaxonomy(normalizeCoverage(raw), symbol)
        const house = await _houseRating(doc)
        if (house) doc.rating = house.band.rating
        doc.price_target = withTargetRef(doc.price_target, null, house)
        const rerated = houseRatingNote(house ?? {})
        if (rerated) logger.info(LOG, 'coverage RE-RATED by the house bands', { symbol, from: house.from, to: house.band.rating, implied: house.band.implied_pct })
        doc.flags = await _plausibilityFlags(doc)
        if (doc.flags.length) logger.warn(LOG, 'coverage FLAGGED — implausible, stored anyway', { symbol, codes: doc.flags.map(f => f.code) })
        const initNote = _str(raw?.init_note) ?? `Initiated coverage on ${symbol}`
        doc.revisions = [newRevision({ kind: 'initiate', note: rerated ? `${initNote}. ${rerated}` : initNote })]
        await db.collection(COLLECTION).insertOne({ ...doc })
        logger.info(LOG, 'coverage initiated', { id: doc.id, symbol, sector: doc.sector, industry: doc.industry })
        if (doc.price_target?.horizon_defaulted) logger.warn(LOG, 'coverage target has NO horizon — stored as 12m (horizon_defaulted)', { symbol })
        _logCall(doc, null)
        return { ok: true, doc: stripId(doc) }
    } catch (err) {
        if (err?.code === 11000) return { ok: false, reason: 'already_covered' }
        logger.error(LOG, 'Failed to initiate coverage', err)
        return { ok: false, error: err }
    }
}

async function getCoverage({ sector = null, status = null, school = null, onError } = {}) {
    try {
        const db = await getDb()
        const filter = {}
        const sec = normalizeSector(sector)
        if (sec) filter.sector = sec
        if (typeof status === 'string' && STATUSES.includes(status)) filter.status = status
        // Atlas mandate-build pre-filter: `schools` is an array field; MongoDB's scalar equality
        // on an array field matches documents where the value appears as an element (implicit $elemMatch).
        if (typeof school === 'string' && SCHOOLS.includes(school)) filter.schools = school
        return (await db.collection(COLLECTION).find(filter).sort({ updated_at: -1 }).toArray()).map(stripId)
    } catch (err) {
        logger.error(LOG, 'getCoverage failed', err)
        if (onError === 'throw') throw err
        return []
    }
}

/**
 * Every covered symbol, uppercased → `string[]`. The read for "which names are taken": Prometheus's
 * chat context, the research run's skip list, the sleeve orchestrator. Those used to call getCoverage
 * and map `.symbol` off full documents — the thesis, the evidence, the whole revision trail — on
 * every turn, to learn a ticker. Projects the one field. `onError: 'throw'` as getCoverage: the run
 * must not mistake an unreadable book for an empty one.
 */
async function listSymbols({ onError, live = false } = {}) {
    try {
        const db   = await getDb()
        // `live`: leave RETIRED theses out — for a reader that shows the book (the Forecasts map, 2026-10-14). The
        // "which names are taken" readers keep every status: a retired name still forces an update, not a new initiation.
        const rows = await db.collection(COLLECTION).find(live ? { status: { $ne: 'retired' } } : {}).project({ _id: 0, symbol: 1 }).toArray()
        return rows.map(r => String(r.symbol ?? '').toUpperCase().trim()).filter(Boolean)
    } catch (err) {
        logger.error(LOG, 'listSymbols failed', err)
        if (onError === 'throw') throw err
        return []
    }
}

async function getCoverageBySymbol(symbol) {
    try {
        const sym = (typeof symbol === 'string' ? symbol : '').toUpperCase().trim()
        if (!sym) return null
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne({ symbol: sym })
        return doc ? stripId(doc) : null
    } catch (err) {
        logger.warn(LOG, 'getCoverageBySymbol failed', err.message)
        return null
    }
}

async function getCoverageById(id) {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne({ id })
        if (!doc) return { ok: false, reason: 'not_found' }
        return { ok: true, doc: stripId(doc) }
    } catch (err) {
        logger.error(LOG, 'getCoverageById failed', err)
        return { ok: false, error: err }
    }
}

async function listActiveBySector(sectors) {
    const want = [...new Set((Array.isArray(sectors) ? sectors : []).map(normalizeSector).filter(Boolean))]
    if (!want.length) return []
    try {
        const db = await getDb()
        return await db.collection(COLLECTION)
            .find({ status: 'active', sector: { $in: want } })
            // The INDUSTRY rides along, because a stance can now be held at that grain and
            // `bottom_up` has to mean "our names in THAT industry" when it is.
            .project({ _id: 0, symbol: 1, sector: 1, industry: 1, rating: 1 })
            .toArray()
    } catch (err) {
        logger.error(LOG, 'sector sweep failed', err)
        return []
    }
}

const LOGGED_FIELDS = ['rating', 'status', 'price_target', 'thesis', 'schools']
const _diffPlan = (prev, next) => diffFields(prev, next, LOGGED_FIELDS)

// What a revision DID, as one line for the card it answers. PURE.
//
// The coverage card in the social chat asks for a revision; when the revision lands the card
// collapses, and a chip that only says "Done" leaves the reader to reopen the thesis to learn
// whether anything moved. This is the analyst's own account of the change — the copy is a
// per-desk judgment (the trail's SHAPE is shared in revisionTrail.js; what it means is not), which
// is why it lives here and the chat transport merely carries it.
const REVISION_VERBS = { remodel: 'Re-modelled', remodel_pass: 'Re-modelled, no new target', update: 'Updated', retire: 'Retired', rating_change: 'Rating changed', target_change: 'Target changed' }
const _pt = v => (v && typeof v === 'object') ? v.value : v
export function revisionSummary(revision) {
    if (!revision || typeof revision !== 'object') return null
    const verb    = REVISION_VERBS[revision.kind] ?? 'Updated'
    const changed = revision.changed ?? {}
    const parts   = []
    if (changed.rating)       parts.push(`rating ${_ratingWord(changed.rating.from)} → ${_ratingWord(changed.rating.to)}`)
    if (changed.price_target) parts.push(`PT ${_pt(changed.price_target.from) ?? '—'} → ${_pt(changed.price_target.to) ?? '—'}`)
    if (changed.status)       parts.push(`status ${changed.status.from ?? '—'} → ${changed.status.to ?? '—'}`)
    if (changed.thesis)       parts.push('thesis rewritten')
    if (changed.schools)      parts.push('schools changed')
    // A revision that moved nothing is still a revision — the view was re-examined and held.
    return `${verb} — ${parts.length ? parts.join(', ') : 'thesis held, rating and target unchanged'}`
}
const _ratingWord = r => (typeof r === 'string' ? r.replace(/_/g, ' ') : '—')

// Which plausibility inputs re-run the flags when patched.
const FLAG_INPUTS = ['rating', 'price_target', 'risk_reward', 'conviction']

/**
 * The `$set` an update writes: ONLY the plan fields the patch touched (as normalised), plus `flags`
 * when the patch re-ran them, plus `updated_at`. Pure — exported for tests.
 *
 * Not the whole merged document. The merged doc is built from a READ, and writing every field of it
 * back is how a second writer's work vanished: the monitor's verdict landing a minute after a
 * re-model set the target wrote the OLD target back over the new one, because its merged copy still
 * carried it. A field the patch did not name is not this write's to touch.
 */
export function _updateSet(patch, merged, { flagsRecomputed = false } = {}) {
    const $set = { updated_at: merged.updated_at }
    for (const k of PLAN_FIELDS) if (k in patch && k !== 'flags') $set[k] = merged[k]
    if (flagsRecomputed) $set.flags = merged.flags
    return $set
}

/**
 * A patch's price target with the stored CLOCK carried over when it reaffirms the call — the same value and horizon, no
 * `set_at` of its own — else the patch's as given. Pure. forecastClock's rule ("reaffirming a call keeps its clock") only
 * holds when `set_at` rides along, and Prometheus's draft never carries one: before this (2026-10-27) every re-model that
 * restated its target restarted the window and pushed its deadline out, so it never came due.
 */
export function keepClock(cur, next) {
    if (!next || typeof next !== 'object' || next.set_at || !cur?.set_at) return next
    const same = _num(next.value) !== null && _num(next.value) === _num(cur.value) && normalizeHorizon(next.horizon) === cur.horizon
    return same ? { ...next, set_at: cur.set_at } : next
}

async function updateCoverage(id, patch = {}) {
    const found = await getCoverageById(id)
    if (!found.ok) return found

    const cur = found.doc
    const p   = (patch && typeof patch === 'object') ? { ...patch } : {}
    if ('price_target' in p) p.price_target = keepClock(cur.price_target, p.price_target)
    const merged = normalizeCoverage({ ...cur, ...p, id: cur.id, symbol: cur.symbol, created_at: cur.created_at, revisions: cur.revisions })

    // The house's rating, whenever the rating, the target or the conviction (it caps a strong rating) moves — written into
    // the patch so the update saves it.
    let rerated = null
    if ('rating' in p || 'price_target' in p || 'conviction' in p) {
        const house = await _houseRating(merged)
        if (house) {
            merged.rating = p.rating = house.band.rating
            rerated = houseRatingNote(house)
            if (rerated) logger.info(LOG, 'coverage update RE-RATED by the house bands', { id, symbol: merged.symbol, from: house.from, to: house.band.rating, implied: house.band.implied_pct })
        }
        // The target's reference: the stored one for a reaffirmed target, today's for a new one — never the draft's own,
        // with or without a price (code review, 2026-11-22: a save echoing the old ref_price with the price read failing).
        if ('price_target' in p) merged.price_target = p.price_target = withTargetRef(merged.price_target, cur.price_target, house)
    }

    const flagsRecomputed = FLAG_INPUTS.some(k => k in p)
    if (flagsRecomputed) {
        merged.flags = await _plausibilityFlags(merged)
        if (merged.flags.length) logger.warn(LOG, 'coverage FLAGGED — implausible, stored anyway', { id, symbol: merged.symbol, codes: merged.flags.map(f => f.code) })
    }

    const note = [_str(p.revision_note), rerated].filter(Boolean).join('. ') || null
    const revision = newRevision({ kind: _str(p.revision_kind) ?? 'update', note, changed: _diffPlan(cur, merged) })

    try {
        const res = await _repo.revise(id, _updateSet(p, merged, { flagsRecomputed }), revision)
        if (!res.ok) return { ok: false, reason: 'not_found' }
        logger.info(LOG, 'coverage updated', { id, kind: revision.kind })
        if ('price_target' in p && merged.price_target?.horizon_defaulted && !cur.price_target?.horizon_defaulted) {
            logger.warn(LOG, 'coverage target has NO horizon — stored as 12m (horizon_defaulted)', { id, symbol: merged.symbol })
        }
        if ('rating' in p || 'price_target' in p) _logCall(merged, cur)
        // The caller's view of the result — merged in memory, the trail as it now reads.
        return { ok: true, doc: { ...stripId(merged), revisions: [revision, ..._arr(cur.revisions)] } }
    } catch (err) {
        logger.error(LOG, 'coverage update failed', err)
        return { ok: false, error: err }
    }
}

/**
 * The call, to Prometheus's scorecard (services/prometheusCalls.service.js) — a new rating, target or horizon is logged
 * frozen there. Fire-and-forget, and loaded on first use: the ledger reads the house book's helpers, which read this
 * module, so a static import would be a cycle. Nothing here waits on it or fails with it.
 */
function _logCall(doc, prev) {
    import('../../services/prometheusCalls.service.js')
        .then(m => m.prometheusCallsService.recordCoverageCall(doc, { prev }))
        .catch(err => logger.warn(LOG, 'scorecard call not logged (thesis unaffected)', err.message))
}

async function captureResearchBasis({ symbol } = {}, deps = { getBySymbol: getCoverageBySymbol }) {
    try {
        const sym = String(symbol ?? '').toUpperCase().trim()
        if (!sym) return null
        const cov = await deps.getBySymbol(sym)
        const pt  = _num(cov?.price_target?.value)
        if (!cov || pt === null) return null
        return { coverageId: cov.id, coveragePt: pt, at: new Date().toISOString() }
    } catch (err) {
        logger.warn(LOG, 'research basis capture failed (caller unaffected)', err.message)
        return null
    }
}

async function retireCoverage(id) {
    return updateCoverage(id, { status: 'retired', revision_kind: 'retire', revision_note: 'Coverage retired' })
}

// ─── The second horizon (docs/design/argus-rework.md step 3, "two targets", stage 1 — Roy, 2026-11-11) ──────────────
//
// A company has a swing answer and a long-term answer. The coverage's `price_target` stays the MAIN one — the book, the
// monitor, the scorecard and a trade's research_basis read it, untouched. `horizon_views.<book>` is Prometheus's view for
// the OTHER book: its own rating (the house's band over its horizon), target, why and what breaks it. Written only when a
// Mentor build needs it (mentorReads); stage 2 (its own place on the lists, the scorecard, the monitor) is not built.

/** The target horizons each book takes — the house book's (houseBook.BOOKS), repeated here: houseBook reads this module. */
export const VIEW_HORIZONS = Object.freeze({ swing: ['3m', '6m'], long_term: ['12m', '18m', '24m'] })

/**
 * A `<horizon_view>` → the stored view, or null when it has no usable target. The horizon must be the book's (a swing view
 * with a 12-month target answers the wrong question); a missing or foreign one takes the book's first. Pure.
 */
export function normalizeHorizonView(raw, book, { now = new Date().toISOString() } = {}) {
    const allowed = VIEW_HORIZONS[book]
    const r = raw && typeof raw === 'object' ? raw : {}
    const t = r.target && typeof r.target === 'object' ? r.target : { value: r.target }
    const value = _num(t.value)
    if (!allowed || !(value > 0)) return null
    const horizon = allowed.includes(t.horizon) ? t.horizon : allowed[0]
    const low = _num(t.low), high = _num(t.high)
    const { ends_at } = openWindow({ set_at: now, horizon }, now)
    return {
        book,
        rating: _str(r.rating),
        target: { value, horizon, target_date: String(ends_at).slice(0, 10), ...(low > 0 && high > 0 && low <= value && value <= high ? { low, high } : {}) },
        why: _str(r.why),
        kill: _arr(r.kill).map(_str).filter(Boolean).slice(0, 4),
        set_at: now,
    }
}

/**
 * Save Prometheus's view for `book` on this coverage — one field and a revision, the main target and thesis untouched. The
 * rating is the HOUSE's band for the view's target over its horizon, as a main target's is. Refused on the coverage's own
 * book (that is its main target's job). → `{ ok, view }` | `{ ok: false, reason }`.
 */
async function setHorizonView(id, book, raw, io = _io) {
    const found = await getCoverageById(id)
    if (!found.ok) return found
    const cur = found.doc
    const main = Object.keys(VIEW_HORIZONS).find(b => VIEW_HORIZONS[b].includes(cur.price_target?.horizon)) ?? null
    if (book === main) return { ok: false, reason: 'main_book' }
    const view = normalizeHorizonView(raw, book)
    if (!view) return { ok: false, reason: 'no_target' }
    const price = _num(await Promise.resolve(io.getPrice(cur.symbol)).catch(() => null))
    view.price_at_set = price > 0 ? Math.round(price * 100) / 100 : null
    // In the stock's σ over the view's own horizon, as a main target's band (2026-11-21). No conviction cap: a view carries
    // none of its own, and the coverage's belongs to the main target.
    const sigma = price > 0 ? _num(await Promise.resolve(io.getSigma?.(cur.symbol, view.target.horizon)).catch(() => null)) : null
    const band = ratingBand({ target: view.target.value, price, horizon: view.target.horizon, sigma_pct: sigma })
    if (band) { view.rating = band.rating; if (band.sigma_pct != null) view.sigma_pct = band.sigma_pct }
    const revision = newRevision({ kind: 'horizon_view', note: `${book === 'swing' ? 'Swing' : 'Long-term'} view: ${String(view.rating ?? 'unrated').replace('_', ' ')}, target ${view.target.value} by ${view.target.target_date}` })
    try {
        const res = await _repo.revise(id, { [`horizon_views.${book}`]: view, updated_at: new Date().toISOString() }, revision)
        if (!res.ok) return { ok: false, reason: 'not_found' }
        logger.info(LOG, 'horizon view saved', { id, symbol: cur.symbol, book, rating: view.rating, target: view.target.value })
        return { ok: true, view }
    } catch (err) {
        logger.error(LOG, 'horizon view not saved', err)
        return { ok: false, reason: 'save_failed', detail: err.message }
    }
}

async function deleteCoverage(id) {
    try {
        const db  = await getDb()
        const res = await db.collection(COLLECTION).deleteOne({ id })
        if (!res.deletedCount) return { ok: false, reason: 'not_found' }
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'coverage delete failed', err)
        return { ok: false, error: err }
    }
}
