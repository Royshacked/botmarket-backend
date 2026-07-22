import { randomUUID }               from 'crypto'
import { getDb, stripId }           from '../../providers/mongodb.provider.js'
import { logger }                   from '../../services/logger.service.js'
import { buildEventRisk }           from '../../services/eventRisk.service.js'
import { cleanConviction }          from '../../services/conviction.util.js'
import { ENTITIES }                 from '../../services/entity/entityCollection.js'
import { normalizeMode, isMode }    from '../../services/kairos.modes.js'

// Kairos = discretionary day/swing agent. Its artifact is a "call" (Idea produces ideas,
// Kairos produces calls): one document in `kairos_calls` = identity + plan (authored at build,
// ~immutable) + monitor_state (written each wake). This module owns persistence and the
// construction-gate validator. It touches NOTHING in `ideas` / the live monitor — Kairos is a
// self-contained trial (see KAIROS_PLAN.md).

const LOG        = '[kairos]'
const COLLECTION = ENTITIES   // calls live in the shared entities collection as kind:'call'
const KIND_CALL  = 'call'

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
    updateKairosCall,
    patchKairosCall,
    getKairosCall,
    listKairosCalls,
    deleteKairosCall,
    getKairosPerformance,
}

// Plan fields re-written on an in-place edit ("Update call"). Identity (id/created_at/user_id),
// monitor_state history, position_state, and linked_idea_id are PRESERVED (never in the $set).
const PLAN_FIELDS = [
    'mode',
    'asset', 'asset_class', 'trade_type', 'bias', 'thesis', 'timeframe_ladder', 'cadence',
    'entry_zones', 'reference_levels', 'patterns', 'sizing', 'broker', 'accounts',
    'main_account_id', 'broker_symbol', 'basis_offset', 'active_from', 'valid_until', 'event_risk',
    'market_sensitivity', 'rr', 'conviction', 'lens_fit',
]

// K4 — a call already in a live position gets a LIGHT edit: only the discretionary CONTEXT fields
// (thesis / levels / patterns / conviction / horizon), NEVER entry_zones / sizing / venue / status /
// execution, and NO monitor re-arm. Hermes keeps managing the live position; a stop/target MOVE goes
// through the manage card, not a plan rewrite. Statuses that mean "past entry" (self-shadow execution
// vocab hit/long/short + the transitional confirmed/in_position).
const POSITION_STATUSES = new Set(['hit', 'long', 'short', 'confirmed', 'in_position'])
const LIGHT_FIELDS = [
    'thesis', 'timeframe_ladder', 'cadence', 'reference_levels', 'patterns',
    'valid_until', 'market_sensitivity', 'rr', 'conviction', 'lens_fit',
]

/**
 * Pure: build the $set for an in-place call edit. IN-POSITION → LIGHT_FIELDS only + NO re-arm (never
 * flip a live call back to 'waiting' — that would orphan the reconciler's position match). PRE-position
 * → full PLAN_FIELDS re-map + re-arm (status→waiting, next check + armed zone cleared).
 */
export function _buildEditSet(cur, full, chatState) {
    const inPosition = POSITION_STATUSES.has(cur?.status)
    const $set = { chat_state: chatState ?? cur?.chat_state ?? null }
    for (const k of (inPosition ? LIGHT_FIELDS : PLAN_FIELDS)) $set[k] = full[k]
    if (!inPosition) {
        $set.status = 'waiting'
        $set['monitor_state.next_check_at'] = null
        $set['monitor_state.armed_zone_id'] = null
    }
    return { $set, inPosition }
}

// Broad-market coupling levels. Anything else (or missing) → Hermes treats the tape as immaterial.
const SENSITIVITY_LEVELS = new Set(['high', 'medium', 'low'])

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
        const query = isAdmin ? { kind: KIND_CALL, status: 'closed' } : { kind: KIND_CALL, status: 'closed', user_id: userId }
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

// Coerce the agent-authored market_sensitivity into the stored shape: a known level (else null →
// "immaterial"), a bounded list of upper-cased driver symbols (the correlated proxies Hermes fetches
// live), and a free-text note. Pure; tolerates a missing/garbage block. Exported for the edit path.
export function _normalizeSensitivity(raw) {
    const ms = raw && typeof raw === 'object' ? raw : {}
    const drivers = (Array.isArray(ms.drivers) ? ms.drivers : [])
        .map(d => String(d).toUpperCase().trim())
        .filter(Boolean)
        .slice(0, 4)
    return {
        level:   SENSITIVITY_LEVELS.has(ms.level) ? ms.level : null,
        drivers,
        note:    ms.note != null ? String(ms.note) : null,
    }
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
        kind:        'call',   // entity discriminator (P3) — a call is its own kind in `entities`
        parentId:    null,
        strategy:    'kairos',
        mode:        normalizeMode(raw.mode),   // build lens (KAIROS_MODES.md) — persisted so edit reopens in-mode
        user_id:     userId,
        created_at:  new Date().toISOString(),
        savedAt:     Date.now(),
        // Build conversation (messages + draft) so the Calls-tab edit pencil can reopen the
        // call in the Kairos chat with its history — mirrors an idea's chat_state.
        chat_state:  raw.chat_state ?? null,

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
        // Time window (both bounds optional, mirrors an idea's `time` condition leaf after/before):
        // active_from = lower bound → Hermes won't monitor before it (a primary gate, cf. isTimeBlocked);
        // valid_until = upper bound → expiry review.
        // Forward-dated scan seed: `build_window` (the list's period) backfills the gate when the model
        // didn't set the bounds itself — so a "November" list item is reliably gated to November even
        // though the model loses the window after the one-shot seed turn. An explicit model/user value
        // (raw.active_from/valid_until, e.g. the user narrowed the dates in chat) always wins.
        active_from:     raw.active_from ?? raw.build_window?.from ?? null,
        valid_until:     raw.valid_until ?? raw.build_window?.to   ?? null,
        // Scheduled catalysts (earnings / FOMC / macro) frozen at build by _stampEventRisk — Hermes
        // reads these to hold off entering into an unresolved binary. Pure copy; the fetch is upstream.
        event_risk:      Array.isArray(raw.event_risk) ? raw.event_risk : [],
        // How much this asset tracks the broad market (a stable structural judgment made at build).
        // `drivers` are the index/sector/correlated proxies Hermes fetches LIVE at entry; `level` tells
        // it how hard to weight the tape. `low`/absent → Hermes skips the market read (tape immaterial).
        market_sensitivity: _normalizeSensitivity(raw.market_sensitivity),
        // Reward-to-risk (zone → first target ÷ zone → invalidation) + the agent's conviction in
        // this call's reasoning — both authored in the Phase 5 pressure-test. Advisory (not gate
        // inputs); conviction reuses the shared idea/portfolio/scanner normalizer.
        // rr must be a POSITIVE number — the `> 0` guard also maps an early draft's null / "" /
        // 0 (Number(null)===0 would otherwise slip through Number.isFinite) back to null.
        rr:         Number.isFinite(Number(raw.rr)) && Number(raw.rr) > 0 ? Number(raw.rr) : null,
        conviction: cleanConviction(raw.conviction),
        // Fit signal (K1): does the setup suit the build mode? 'weak' + suggested_mode flags a switch
        // (the user decides whether to rebuild). Advisory — never gates the call.
        lens_fit: {
            fit:            raw.lens_fit?.fit === 'weak' ? 'weak' : 'good',
            suggested_mode: (raw.lens_fit?.fit === 'weak' && isMode(raw.lens_fit?.suggested_mode)) ? raw.lens_fit.suggested_mode : null,
        },

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
// Fetch the call's scheduled catalysts ONCE and fold them into raw before normalize (which is pure /
// no-I/O). Never throws — buildEventRisk returns [] on any failure — so calendar downtime can't block
// a save. Runs on both create and edit so a re-mapped asset/date refreshes the frozen list.
async function _stampEventRisk(raw) {
    const event_risk = await buildEventRisk({ asset: raw.asset, assetClass: raw.asset_class })
    return { ...raw, event_risk }
}

async function saveKairosCall(raw, userId) {
    const gate = validateCall(raw)
    if (!gate.ok) {
        logger.warn(LOG, 'call rejected by construction gate', { reason: gate.reason, asset: raw?.asset })
        return { ok: false, reason: gate.reason }
    }

    try {
        const doc = normalizeCall(await _stampEventRisk(raw), userId)
        const db  = await getDb()
        await db.collection(COLLECTION).insertOne(doc)
        logger.info(LOG, 'call saved', { id: doc.id, asset: doc.asset, trade_type: doc.trade_type })
        return { ok: true, call: stripId(doc) }
    } catch (err) {
        logger.error(LOG, 'Failed to save call', err)
        return { ok: false, error: err }
    }
}

// In-place plan update (the "Update call" button — parity with updateIdea on an edited idea).
// Re-validates + re-normalizes the plan exactly like a fresh save, then $sets ONLY the plan fields
// (+ chat_state) onto the existing doc, RE-ARMING the monitor (status→waiting, next check cleared)
// so Hermes re-evaluates the new plan from scratch. Identity + monitor history + position_state kept.
async function updateKairosCall(id, raw, userId, isAdmin = false) {
    const gate = validateCall(raw)
    if (!gate.ok) {
        logger.warn(LOG, 'call update rejected by construction gate', { reason: gate.reason, id })
        return { ok: false, reason: gate.reason }
    }
    try {
        const db  = await getDb()
        const cur = await db.collection(COLLECTION).findOne({ id })
        if (!cur) return { ok: false, reason: 'not_found' }
        if (cur.user_id && cur.user_id !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }

        const full = normalizeCall(await _stampEventRisk(raw), cur.user_id ?? userId)   // fresh normalized plan (re-ids zones/levels) + refreshed event_risk
        const { $set, inPosition } = _buildEditSet(cur, full, raw.chat_state)   // in-position → LIGHT edit, no re-arm
        $set.savedAt = Date.now()

        await db.collection(COLLECTION).updateOne({ id }, { $set })
        const updated = await db.collection(COLLECTION).findOne({ id })
        logger.info(LOG, 'call updated', { id, asset: updated.asset, inPosition, mode: inPosition ? 'light' : 're-arm' })
        return { ok: true, call: stripId(updated) }
    } catch (err) {
        logger.error(LOG, 'Failed to update call', err)
        return { ok: false, error: err }
    }
}

// Lightweight partial patch — progressive chat_state save during an edit session (no re-validation,
// no plan change). Whitelisted to chat_state so a stray field can't rewrite the plan.
async function patchKairosCall(id, patch, userId, isAdmin = false) {
    try {
        const db  = await getDb()
        const cur = await db.collection(COLLECTION).findOne({ id }, { projection: { user_id: 1 } })
        if (!cur) return { ok: false, reason: 'not_found' }
        if (cur.user_id && cur.user_id !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }
        if (!patch || !Object.prototype.hasOwnProperty.call(patch, 'chat_state')) return { ok: true }
        await db.collection(COLLECTION).updateOne({ id }, { $set: { chat_state: patch.chat_state } })
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to patch call', err)
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
        const query = isAdmin ? { kind: KIND_CALL } : { kind: KIND_CALL, user_id: userId }
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
