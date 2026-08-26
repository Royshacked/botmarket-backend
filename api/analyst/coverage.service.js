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
import { getDb }           from '../../providers/mongodb.provider.js'
import { logger }          from '../../services/logger.service.js'
import { cleanConviction } from '../../services/conviction.util.js'
import { toNum }           from '../../services/format.util.js'
import { HORIZONS, DEFAULT_HORIZON, openWindow } from '../../services/forecastClock.js'
import { normalizeSector }  from '../../services/entity/vocabulary.js'
import { newRevision, diffFields } from '../../services/revisionTrail.js'

const LOG = '[coverage]'
export const COLLECTION = 'coverage'

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
export const SCHOOLS = ['quality_value', 'growth_durability', 'income', 'passive']

const PLAN_FIELDS = ['sector', 'thesis', 'rating', 'price_target', 'estimates', 'gap',
    'catalysts', 'kill_criteria', 'risk_reward', 'conviction', 'status', 'evidence', 'flags', 'schools']

export const coverageService = {
    initiateCoverage,
    getCoverage,
    getCoverageBySymbol,
    getCoverageById,
    listActiveBySector,
    updateCoverage,
    retireCoverage,
    deleteCoverage,
    captureResearchBasis,
    recordMonitorState,
    claimRemodel,
}

// ─── monitor.* namespace ─────────────────────────────────────────────────────

async function recordMonitorState(id, { set = {}, inc = null } = {}) {
    const db = await getDb()
    const update = { $set: set }
    if (inc) update.$inc = inc
    const res = await db.collection(COLLECTION).updateOne({ id }, update)
    return { ok: res.matchedCount === 1 }
}

async function claimRemodel(id, { previousAt = null, reason, at = new Date().toISOString() } = {}) {
    const db  = await getDb()
    const res = await db.collection(COLLECTION).updateOne(
        { id, 'monitor.last_remodel_at': previousAt ?? null },
        {
            $set: { 'monitor.last_remodel_at': at, 'monitor.last_remodel_reason': reason },
            $inc: { 'monitor.remodels': 1 },
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
        try {
            const { fetchLastPrice } = await import('../../monitoring/monitorUtils.js')
            return await fetchLastPrice(symbol)
        } catch { return null }
    },
    getMultipleHistory: async (symbol) => {
        try {
            const { getHistoricalMultiples } = await import('../../providers/fmp.provider.js')
            return await getHistoricalMultiples(symbol, 'pe')
        } catch { return [] }
    },
}
export function _setCoverageIO(io) { Object.assign(_io, io) }

async function _checkCoherence(doc, io = _io) {
    const rating = doc?.rating
    if (!BULLISH_RATINGS.has(rating) && !BEARISH_RATINGS.has(rating)) return { ok: true }
    if (_num(doc?.price_target?.value) === null) return { ok: true }
    return ratingCoherence({ rating, price_target: doc.price_target, price: await io.getPrice(doc.symbol) })
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
    return { value, horizon, basis: _str(pt.basis), set_at, target_date: ends_at }
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
    await db.collection(COLLECTION).createIndex({ symbol: 1 }, { unique: true })
    await db.collection(COLLECTION).createIndex({ sector: 1, status: 1, schools: 1 })
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

        const doc = normalizeCoverage(raw)
        const coherent = await _checkCoherence(doc)
        if (!coherent.ok) {
            logger.warn(LOG, 'coverage REJECTED — rating contradicts target', { symbol, rating: doc.rating, pt: doc.price_target?.value, detail: coherent.detail })
            return coherent
        }
        doc.flags = await _plausibilityFlags(doc)
        if (doc.flags.length) logger.warn(LOG, 'coverage FLAGGED — implausible, stored anyway', { symbol, codes: doc.flags.map(f => f.code) })
        doc.revisions = [newRevision({ kind: 'initiate', note: _str(raw?.init_note) ?? `Initiated coverage on ${symbol}` })]
        await db.collection(COLLECTION).insertOne({ ...doc })
        logger.info(LOG, 'coverage initiated', { id: doc.id, symbol, sector: doc.sector })
        return { ok: true, doc: _strip(doc) }
    } catch (err) {
        if (err?.code === 11000) return { ok: false, reason: 'already_covered' }
        logger.error(LOG, 'Failed to initiate coverage', err)
        return { ok: false, error: err }
    }
}

async function getCoverage({ sector = null, status = null, onError } = {}) {
    try {
        const db = await getDb()
        const filter = {}
        const sec = normalizeSector(sector)
        if (sec) filter.sector = sec
        if (typeof status === 'string' && STATUSES.includes(status)) filter.status = status
        return (await db.collection(COLLECTION).find(filter).sort({ updated_at: -1 }).toArray()).map(_strip)
    } catch (err) {
        logger.error(LOG, 'getCoverage failed', err)
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
        return doc ? _strip(doc) : null
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
        return { ok: true, doc: _strip(doc) }
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
            .project({ _id: 0, symbol: 1, sector: 1 })
            .toArray()
    } catch (err) {
        logger.error(LOG, 'sector sweep failed', err)
        return []
    }
}

const LOGGED_FIELDS = ['rating', 'status', 'price_target', 'thesis', 'schools']
const _diffPlan = (prev, next) => diffFields(prev, next, LOGGED_FIELDS)

async function updateCoverage(id, patch = {}) {
    const found = await getCoverageById(id)
    if (!found.ok) return found

    const cur = found.doc
    const p   = (patch && typeof patch === 'object') ? patch : {}
    const merged = normalizeCoverage({ ...cur, ...p, id: cur.id, symbol: cur.symbol, created_at: cur.created_at, revisions: cur.revisions })

    if ('rating' in p || 'price_target' in p) {
        const coherent = await _checkCoherence(merged)
        if (!coherent.ok) {
            logger.warn(LOG, 'coverage update REJECTED — rating contradicts target', { id, symbol: merged.symbol, rating: merged.rating, pt: merged.price_target?.value, detail: coherent.detail })
            return coherent
        }
    }

    if (['rating', 'price_target', 'risk_reward', 'conviction'].some(k => k in p)) {
        merged.flags = await _plausibilityFlags(merged)
        if (merged.flags.length) logger.warn(LOG, 'coverage FLAGGED — implausible, stored anyway', { id, symbol: merged.symbol, codes: merged.flags.map(f => f.code) })
    }

    const revision  = newRevision({ kind: _str(p.revision_kind) ?? 'update', note: _str(p.revision_note), changed: _diffPlan(cur, merged) })
    const revisions = [revision, ..._arr(cur.revisions)]

    const $set = { updated_at: merged.updated_at, revisions }
    for (const k of PLAN_FIELDS) $set[k] = merged[k]

    try {
        const db  = await getDb()
        const res = await db.collection(COLLECTION).updateOne({ id }, { $set })
        if (!res.matchedCount) return { ok: false, reason: 'not_found' }
        logger.info(LOG, 'coverage updated', { id, kind: revision.kind })
        return { ok: true, doc: { ..._strip(merged), revisions } }
    } catch (err) {
        logger.error(LOG, 'coverage update failed', err)
        return { ok: false, error: err }
    }
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

// Strip Mongo's _id before returning to callers.
function _strip(doc) {
    if (!doc) return doc
    const { _id, ...rest } = doc
    return rest
}
