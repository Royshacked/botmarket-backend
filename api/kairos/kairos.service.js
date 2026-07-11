import { randomUUID }               from 'crypto'
import { getDb, stripId }           from '../../providers/mongodb.provider.js'
import { logger }                   from '../../services/logger.service.js'

// Kairos = discretionary day/swing agent. Its artifact is a "call" (Idea produces ideas,
// Kairos produces calls): one document in `kairos_calls` = identity + plan (authored at build,
// ~immutable) + monitor_state (written each wake). This module owns persistence and the
// construction-gate validator. It touches NOTHING in `ideas` / the live monitor — Kairos is a
// self-contained trial (see KAIROS_PLAN.md).

const LOG        = '[kairos]'
const COLLECTION = 'kairos_calls'

const TRADE_TYPES = new Set(['intraday', 'day', 'swing'])
const BROKERS     = new Set(['ctrader', 'paper', 'manual'])

// Fallback self-scheduling bounds (minutes) per horizon, used when the call omits cadence.
// Clamps the monitor's agent-chosen next_check_at so adaptive cadence can't run away (Phase 2).
const DEFAULT_CADENCE = {
    intraday: { min: 1, max: 5  },
    day:      { min: 1, max: 15 },
    swing:    { min: 5, max: 30 },
}

export const kairosService = {
    saveKairosCall,
    getKairosCall,
    listKairosCalls,
    deleteKairosCall,
    getKairosPerformance,
}

// ── Performance (Phase 5, slice 4) ────────────────────────────────────────────
// Aggregate closed calls' outcomes into a Kairos track record. A "win" is positive realized P&L
// when known, else positive R. avg_r doubles as the R-expectancy (mean R per trade). Pure.
export function computeKairosPerformance(calls) {
    const outcomes = (Array.isArray(calls) ? calls : [])
        .filter(c => c?.status === 'closed' && c?.position_state?.outcome)
        .map(c => c.position_state.outcome)

    // NB: guard `!= null` BEFORE Number() — Number(null) is 0 (finite), which would wrongly treat an
    // unknown P&L as a known break-even (and count it in total_pnl).
    const pnlKnown = o => o?.pnl != null && Number.isFinite(Number(o.pnl))
    const n     = outcomes.length
    const rs    = outcomes.map(o => o.r_multiple).filter(x => x != null && Number.isFinite(Number(x))).map(Number)
    const pnls  = outcomes.filter(pnlKnown).map(o => Number(o.pnl))
    const isWin = o => (pnlKnown(o) ? Number(o.pnl) > 0 : Number(o.r_multiple) > 0)
    const isLoss= o => (pnlKnown(o) ? Number(o.pnl) < 0 : Number(o.r_multiple) < 0)
    const sum   = a => a.reduce((s, x) => s + x, 0)
    const r2    = x => Math.round(x * 100) / 100
    const wins  = outcomes.filter(isWin).length

    return {
        closed:    n,
        wins,
        losses:    outcomes.filter(isLoss).length,
        win_rate:  n ? r2(wins / n) : null,          // fraction 0–1
        avg_r:     rs.length ? r2(sum(rs) / rs.length) : null,   // == R-expectancy
        total_pnl: pnls.length ? r2(sum(pnls)) : null,
        best_r:    rs.length ? Math.max(...rs) : null,
        worst_r:   rs.length ? Math.min(...rs) : null,
    }
}

async function getKairosPerformance(userId, isAdmin = false) {
    try {
        const db    = await getDb()
        const query = isAdmin ? { status: 'closed' } : { status: 'closed', user_id: userId }
        const calls = await db.collection(COLLECTION)
            .find(query, { projection: { status: 1, position_state: 1 } })
            .toArray()
        return { ok: true, performance: computeKairosPerformance(calls) }
    } catch (err) {
        logger.error(LOG, 'Failed to compute performance', err)
        return { ok: false, error: err }
    }
}

export async function ensureKairosIndexes() {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true })
        await db.collection(COLLECTION).createIndex({ user_id: 1 })
        await db.collection(COLLECTION).createIndex({ status: 1 })
    } catch (err) {
        logger.warn(LOG, 'ensureKairosIndexes failed:', err.message)
    }
}

// ── Construction gate ───────────────────────────────────────────────────────
// A call cannot be persisted (nor generated, Phase 1) without the four build inputs:
// trade_type + ≥1 usable entry_zone + a size cap + a trading venue. Returns { ok:true } or
// { ok:false, reason } — single-reason style matching the idea service.
export function validateCall(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'invalid_call' }

    if (!TRADE_TYPES.has(raw.trade_type)) return { ok: false, reason: 'invalid_trade_type' }

    const zones = Array.isArray(raw.entry_zones) ? raw.entry_zones : []
    if (zones.length === 0) return { ok: false, reason: 'no_entry_zone' }
    for (const z of zones) {
        const lower  = Number(z?.lower)
        const upper  = Number(z?.upper)
        const anchor = Number(z?.anchor)
        // The band is the machine-read gate — it MUST be a real interval.
        if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
            return { ok: false, reason: 'invalid_zone' }
        }
        // Anchor is optional here (normalize fills the midpoint), but if given it must sit inside.
        if (Number.isFinite(anchor) && (anchor < lower || anchor > upper)) {
            return { ok: false, reason: 'invalid_zone' }
        }
    }

    const maxSize = Number(raw?.sizing?.max_size)
    if (!Number.isFinite(maxSize) || maxSize <= 0) return { ok: false, reason: 'no_max_size' }

    if (!BROKERS.has(raw.broker)) return { ok: false, reason: 'no_venue' }
    // Paper derives its account (paper-<userId>); live/manual must be marked explicitly.
    const accounts = Array.isArray(raw.accounts) ? raw.accounts : []
    if (accounts.length === 0 && raw.broker !== 'paper') return { ok: false, reason: 'no_venue' }

    return { ok: true }
}

// ── Normalization ───────────────────────────────────────────────────────────
// Turn a raw (validated) call into the stored document shape: stable ids on every
// zone/level/pattern, numeric coercion, defaulted cadence + monitor_state. Pure; no I/O.
function _assignIds(arr, prefix) {
    return (Array.isArray(arr) ? arr : []).map((item, i) => ({ ...item, id: item?.id || `${prefix}${i + 1}` }))
}

// Exported so an accepted edit (Phase 3) can re-normalize re-mapped zones/levels the same way.
export function normalizeZones(rawZones, bias = null) {
    return _assignIds(rawZones, 'ez').map(z => {
        const lower = Number(z.lower)
        const upper = Number(z.upper)
        let anchor  = Number(z.anchor)
        if (!Number.isFinite(anchor)) anchor = (lower + upper) / 2   // midpoint fallback
        return { id: z.id, side: z.side ?? bias ?? null, anchor, lower, upper, kind: z.kind ?? null, note: z.note ?? null }
    })
}

export function normalizeReferenceLevels(rawRefs) {
    return _assignIds(rawRefs, 'rl').map(r => ({ id: r.id, kind: r.kind ?? null, price: Number(r.price), note: r.note ?? null }))
}

export function normalizeCall(raw, userId = null) {
    const zones           = normalizeZones(raw.entry_zones, raw.bias)
    const referenceLevels = normalizeReferenceLevels(raw.reference_levels)

    const patterns = _assignIds(raw.patterns, 'p').map(p => ({
        id:         p.id,
        name:       p.name ?? null,
        type:       p.type ?? null,
        weight:     p.weight ?? null,
        // Honesty flag: anything not explicitly measured is an LLM prior, not an observation.
        evidence:   p.evidence === 'observed' ? 'observed' : 'inferred',
        confidence: p.confidence != null ? Number(p.confidence) : null,
        timeframe:  p.timeframe ?? null,
        relates_to: Array.isArray(p.relates_to) ? p.relates_to : [],
        look_for:   p.look_for ?? null,
    }))

    const dflt    = DEFAULT_CADENCE[raw.trade_type] ?? DEFAULT_CADENCE.day
    const cadence = {
        min_gap_min: Number(raw?.cadence?.min_gap_min) || dflt.min,
        max_gap_min: Number(raw?.cadence?.max_gap_min) || dflt.max,
    }

    const accounts = Array.isArray(raw.accounts) ? raw.accounts : []

    return {
        // ── identity ──
        id:          `call_${String(raw.asset || 'x').replace(/[^A-Za-z0-9]/g, '')}_${randomUUID().slice(0, 8)}`,
        strategy:    'kairos',
        user_id:     userId,
        created_at:  new Date().toISOString(),
        savedAt:     Date.now(),

        // ── plan (authored at build, ~immutable) ──
        asset:            raw.asset ?? '',
        asset_class:      raw.asset_class ?? null,
        trade_type:       raw.trade_type,
        bias:             raw.bias ?? null,
        thesis:           raw.thesis ?? null,
        timeframe_ladder: Array.isArray(raw.timeframe_ladder) ? raw.timeframe_ladder : [],
        cadence,
        entry_zones:      zones,
        reference_levels: referenceLevels,
        patterns,
        sizing: {
            max_size:   Number(raw.sizing.max_size),
            unit:       raw.sizing?.unit ?? null,
            risk_basis: raw.sizing?.risk_basis ?? null,
        },
        broker:          raw.broker,
        accounts,
        main_account_id: raw.main_account_id ?? accounts[0] ?? null,
        broker_symbol:   raw.broker_symbol ?? raw.asset ?? null,   // Phase 1 symbol gate refines this
        basis_offset:    Number(raw.basis_offset) || 0,            // boundary-only, applied at order edge
        valid_until:     raw.valid_until ?? null,

        // ── monitor_state (written each wake, Phase 2) ──
        status: 'waiting',
        monitor_state: {
            next_check_at:   null,
            armed_zone_id:   null,
            chosen_timeframe: null,
            check_count:     0,
            memo:            '',
            last_assessment: null,
        },
    }
}

// ── Persistence ─────────────────────────────────────────────────────────────
async function saveKairosCall(raw, userId) {
    const gate = validateCall(raw)
    if (!gate.ok) {
        logger.warn(LOG, 'call rejected by construction gate', { reason: gate.reason, asset: raw?.asset })
        return { ok: false, reason: gate.reason }
    }

    try {
        const doc = normalizeCall(raw, userId)
        const db  = await getDb()
        await db.collection(COLLECTION).insertOne(doc)
        logger.info(LOG, 'call saved', { id: doc.id, asset: doc.asset, trade_type: doc.trade_type })
        return { ok: true, call: stripId(doc) }
    } catch (err) {
        logger.error(LOG, 'Failed to save call', err)
        return { ok: false, error: err }
    }
}

async function getKairosCall(id, userId, isAdmin = false) {
    try {
        const db   = await getDb()
        const call = await db.collection(COLLECTION).findOne({ id })
        if (!call) return { ok: false, reason: 'not_found' }
        if (call.user_id && call.user_id !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }
        return { ok: true, call: stripId(call) }
    } catch (err) {
        logger.error(LOG, 'Failed to get call', err)
        return { ok: false, error: err }
    }
}

async function listKairosCalls(userId, isAdmin = false) {
    try {
        const db    = await getDb()
        const query = isAdmin ? {} : { user_id: userId }
        const items = await db.collection(COLLECTION).find(query).sort({ savedAt: -1 }).toArray()
        return items.map(stripId)
    } catch (err) {
        logger.error(LOG, 'Failed to list calls', err)
        return []
    }
}

async function deleteKairosCall(id, userId, isAdmin = false) {
    try {
        const db   = await getDb()
        const call = await db.collection(COLLECTION).findOne({ id }, { projection: { user_id: 1 } })
        if (!call) return { ok: false, reason: 'not_found' }
        if (call.user_id && call.user_id !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }
        await db.collection(COLLECTION).deleteOne({ id })
        logger.info(LOG, 'call deleted', { id })
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to delete call', err)
        return { ok: false, error: err }
    }
}
