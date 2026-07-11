import Anthropic from '@anthropic-ai/sdk'
import { getDb } from '../providers/mongodb.provider.js'
import { getQuote, getTickerAggregates } from '../providers/yahoofinance.provider.js'
import { fetchChartImage } from '../providers/chartImg.provider.js'
import { buildStudies } from './evaluators/chart.evaluator.js'
import { userService } from '../api/user/user.service.js'
import { isAssetOpen, getMarketStatus } from '../services/market.service.js'
import { logger } from '../services/logger.service.js'
import { notifyCallReady, notifyCallExpiry, notifyCallManage } from '../services/tradeNotify.service.js'
import { withTimeout, extractFirstJSON } from './monitorUtils.js'

// Hermes — the Kairos-call readiness monitor: a self-scheduling readiness loop (KAIROS_PLAN.md,
// Phase 2). Its own tick, its own collection (`kairos_calls`), sharing NO mutable state with Minos
// (the live idea monitor).
// Design: a CHEAP arithmetic gate (is price inside a mapped zone?) runs every wake; the EXPENSIVE
// four-axis LLM assessment fires only when a zone is tripped or the call is near expiry. Each
// assessment writes back the verdict + a self-chosen next_check_at (clamped to the call's cadence)
// + a running memo carried across wakes. Pre-entry readiness only — hands off at the enter card.

const LOG          = '[hermes.monitor]'
const COLLECTION   = 'kairos_calls'
const POLL_INTERVAL_MS = 60_000
// Only these are re-checked by the loop. `expiry_review` is triggered TIME-based on these two
// (via _isExpiring), so 'expiring' is NOT here — like 'ready', it's an awaiting-user state (an
// edit card was fired) that Phase 3 re-queues to 'waiting' on accept, preventing card spam.
const ACTIVE_STATUSES  = ['waiting', 'watching']
// Post-confirm statuses routed to the position path (NOT the zone-gate readiness path): Hermes
// watches the linked idea to promote confirmed→in_position on fill and in_position→closed on close
// (Phase 5). `confirmed` = order placed / awaiting fill; `in_position` = live and managed.
const POSITION_STATUSES = ['confirmed', 'in_position']
const EXPIRY_THRESHOLD_MS = 15 * 60_000   // run the final "expiry review" within 15m of valid_until
// A single check must never wedge the loop. If any IO inside _checkCall (vision assess / chart /
// price fetch) hangs with no timeout, the awaited call never returns, `_running` stays true, and
// every later tick skips forever. Bounding each check lets a hung one reject so the loop recovers.
const CHECK_TIMEOUT_MS = 90_000

let _timer   = null
let _running = false

export const hermesService = { start, stop }

function start() {
    if (_timer) return
    logger.info(LOG, 'Kairos monitor starting')
    _tick()
    _timer = setInterval(_tick, POLL_INTERVAL_MS)
}

function stop() {
    if (!_timer) return
    clearInterval(_timer)
    _timer = null
    logger.info(LOG, 'Kairos monitor stopped')
}

// Race a promise against a timeout so a hung await can't wedge the loop. Shared impl lives in
// monitorUtils (used by Minos too); re-exported here under the historical name for tests.
export const _withTimeout = withTimeout

// ─── Poll loop ────────────────────────────────────────────────────────────────
async function _tick() {
    if (_running) { logger.warn(LOG, 'previous tick still running — skipping'); return }
    _running = true
    try {
        const db  = await getDb()
        const now = new Date().toISOString()
        // Due = active status AND (never checked OR next_check_at has passed). ISO strings compare
        // lexicographically for same-format UTC timestamps, so $lte on the string is correct.
        const calls = await db.collection(COLLECTION).find({
            status: { $in: [...ACTIVE_STATUSES, ...POSITION_STATUSES] },
            $or: [
                { 'monitor_state.next_check_at': null },
                { 'monitor_state.next_check_at': { $lte: now } },
            ],
        }).toArray()

        if (!calls.length) return
        logger.info(LOG, `checking ${calls.length} due call(s)`)
        for (const call of calls) {
            // Claim the call by leasing its next_check_at forward BEFORE assessing. Because
            // _withTimeout abandons (but can't cancel) a slow _checkCall, a still-running check
            // whose next_check_at hasn't been persisted yet would otherwise be re-selected by the
            // next tick and processed a SECOND time concurrently — double-firing readiness/manage
            // cards. The lease (≥ the check timeout) makes the re-query miss it until the check has
            // certainly stopped; _checkCall's own _persist overwrites the lease with the real cadence.
            if (!(await _claimCall(db, call, Date.now()))) {
                logger.info(LOG, `call ${call.id} already claimed/rescheduled — skipping`)
                continue
            }
            try { await _withTimeout(_checkCall(db, call, Date.now(), _deps), CHECK_TIMEOUT_MS) }
            catch (err) { logger.error(LOG, `checkCall failed for ${call.id}:`, err.message) }
        }
    } catch (err) {
        logger.error(LOG, 'tick failed:', err.message)
    } finally {
        _running = false
    }
}

// How far forward a claim leases next_check_at. Must be ≥ CHECK_TIMEOUT_MS so a claimed call
// can't be re-selected until any abandoned (timed-out) check has certainly stopped running.
const CLAIM_LEASE_MS = CHECK_TIMEOUT_MS

// Atomically claim a due call for this tick by pushing its next_check_at a lease-horizon forward,
// conditional on it STILL being due (guards against clobbering a fresher schedule). Returns true
// iff this call won the claim. Idempotent and cheap — one conditional updateOne.
async function _claimCall(db, call, nowMs) {
    const nowIso     = new Date(nowMs).toISOString()
    const leaseUntil = new Date(nowMs + CLAIM_LEASE_MS).toISOString()
    const res = await db.collection(COLLECTION).updateOne(
        {
            id: call.id,
            status: call.status,
            $or: [
                { 'monitor_state.next_check_at': null },
                { 'monitor_state.next_check_at': { $lte: nowIso } },
            ],
        },
        { $set: { 'monitor_state.next_check_at': leaseUntil } },
    )
    return res.modifiedCount === 1
}

// Orchestrate one call: cheap gate → (only if tripped/expiring) expensive assessment → persist.
// `deps` is injectable so tests exercise the branching without real price/LLM/notify IO.
export async function _checkCall(db, call, nowMs, deps = _deps) {
    // Post-confirm: route to the position path (watch the linked idea), not the readiness gate.
    if (POSITION_STATUSES.includes(call.status)) return _checkPosition(db, call, nowMs, deps)

    // Primary time gate: a call whose active_from is still in the future isn't live yet — skip ALL
    // work (no price, no LLM) and SLEEP until it opens, exactly like the market-closed path. Mirrors
    // the idea monitor's isTimeBlocked. Runs before the expiry/market/price gates (a not-yet-active
    // call can't be expiring — active_from precedes valid_until).
    if (_isPreActive(call, nowMs)) {
        const patch = _scheduledPatch(call, nowMs)               // also resets a stale 'watching' → 'waiting'
        // Wake exactly when it goes active. Normalize to a Z-ISO string (like every other next_check_at
        // write) so the poll loop's lexicographic $lte holds even if active_from carried a UTC offset.
        const wakeAt = new Date(Date.parse(call.active_from)).toISOString()
        patch['monitor_state.next_check_at'] = wakeAt
        const entry = _timelineEntry('pre_active', { nowMs, call, nextAt: wakeAt })
        await _persist(db, call.id, patch, entry)
        return { reason: 'pre_active' }
    }

    const expiring = _isExpiring(call, nowMs)

    // Market closed for this asset → no entry can happen; skip the check (no price fetch, no LLM)
    // and SLEEP until the market reopens (not the normal cadence). Expiry review is exempt — a
    // call may need to roll/expire at the close.
    if (!expiring && !deps.isAssetOpen(call.asset, call.asset_class)) {
        const patch  = _scheduledPatch(call, nowMs)   // also resets a stale 'watching' → 'waiting'
        const openMs = deps.nextOpenMs?.(call.asset, call.asset_class)
        if (Number.isFinite(openMs) && openMs > nowMs) patch['monitor_state.next_check_at'] = new Date(openMs).toISOString()
        const entry = _timelineEntry('closed', { nowMs, call, nextAt: patch['monitor_state.next_check_at'] })
        await _persist(db, call.id, patch, entry)
        return { reason: 'closed' }
    }

    const price  = await deps.getPrice(call)
    const zone   = Number.isFinite(price) ? _zoneGate(call, price) : null

    const reason = expiring ? 'expiry_review' : (zone ? 'zone_trip' : 'scheduled')

    // Cheap path: not near a zone and not expiring → no LLM, just reschedule further out.
    if (reason === 'scheduled') {
        const patch = _scheduledPatch(call, nowMs)
        const entry = _timelineEntry('scheduled', { nowMs, price, call, nextAt: patch['monitor_state.next_check_at'] })
        await _persist(db, call.id, patch, entry)
        return { reason }
    }

    // Expensive path: the four-axis readiness read (LLM + vision).
    const raw = await deps.assess(call, zone, { reason, price }, deps)
    if (!raw) {
        // Assessment failed — retry soon (min cadence) rather than dropping the call.
        const patch = _scheduledPatch(call, nowMs, true)
        const entry = _timelineEntry(reason, { nowMs, price, call, nextAt: patch['monitor_state.next_check_at'], failed: true })
        await _persist(db, call.id, patch, entry)
        return { reason, failed: true }
    }

    const { set, fireCard, lastAssessment } = _applyAssessment(call, zone, raw, nowMs, reason)
    const entry = _timelineEntry(reason, { nowMs, price, zone, call, raw, nextAt: set['monitor_state.next_check_at'], fetched: _fetchedLabel(call) })
    await _persist(db, call.id, set, entry)
    if (fireCard) {
        try { await deps.onCard(call, lastAssessment) }
        catch (err) { logger.warn(LOG, `onCard failed for ${call.id}:`, err.message) }
    }
    return { reason, verdict: raw.verdict, fireCard }
}

// Persist the $set patch and, when given, APPEND a journal entry (capped to the last TIMELINE_MAX).
async function _persist(db, id, set, logEntry = null) {
    const update = { $set: set }
    if (logEntry) update.$push = { 'monitor_state.timeline': { $each: [logEntry], $slice: -TIMELINE_MAX } }
    await db.collection(COLLECTION).updateOne({ id }, update)
}

// ─── In-position path (Phase 5, slice 1: lifecycle reconcile only — no brain yet) ──────────────
// A confirmed/in_position call has a linked idea holding the real position. Hermes reads that idea
// (broker-authoritative, maintained by the event-driven reconciler) and reconciles the call:
// confirmed→in_position when the idea opens, in_position→closed when it closes. The discretionary
// management brain (assess → propose → card) is slice 2.
export async function _checkPosition(db, call, nowMs, deps = _deps) {
    const idea = await deps.getIdea(call.linked_idea_id)
    // On a transition (fill or close) source the broker-authoritative trade (real entry/exit price +
    // realized P&L) from the ledger (slice 4). Not needed on idle-awaiting-fill or the manage path.
    const needTrade = idea && ['long', 'short', 'closed'].includes(idea.status)
    const trade = (needTrade && deps.getTrade) ? await deps.getTrade(idea).catch(() => null) : null
    const rec  = _reconcilePosition(call, idea, nowMs, trade)
    // in_position + still open → the discretionary management brain (slice 2). All other cases
    // (promote / close / idle-awaiting-fill) are pure status transitions handled by _reconcilePosition.
    if (rec.manage) return _managePosition(db, call, idea, nowMs, deps)
    await _persist(db, call.id, rec.set, rec.entry)
    return { reason: 'position', status: rec.set.status ?? call.status }
}

// Pure. Decide the call's next state from the linked idea's status. Returns { set, entry } where
// `entry` is a journal line to append (or null on an idle wake). The journal is UNIFIED — these
// entries append to the same monitor_state.timeline as the pre-entry readiness wakes.
export function _reconcilePosition(call, idea, nowMs, trade = null) {
    const cadenceMs = (Number(call?.cadence?.max_gap_min) || 15) * 60_000
    const nextAt    = new Date(nowMs + cadenceMs).toISOString()
    const bumpCount = (call?.monitor_state?.check_count ?? 0) + 1
    const idle = { set: { 'monitor_state.next_check_at': nextAt, 'monitor_state.check_count': bumpCount }, entry: null }

    if (!idea) return idle   // linked idea not found yet — look again next cadence

    const inPos = idea.status === 'long' || idea.status === 'short'

    if (call.status === 'confirmed') {
        if (inPos)                    return _promoteToInPosition(call, idea, nowMs, nextAt, bumpCount, trade)
        if (idea.status === 'closed') return _closeFromIdea(call, idea, nowMs, bumpCount, trade)   // opened+closed / rejected before we saw
        return idle   // still awaiting fill (looking / hit / resting)
    }
    // in_position
    if (idea.status === 'closed') return _closeFromIdea(call, idea, nowMs, bumpCount, trade)
    return { manage: true }   // still open → _checkPosition runs the management brain
}

// confirmed → in_position: stamp the fill onto the pre-seeded position_state and open the journal
// for the management era. fill_price is best-effort in slice 1 (the intended entry); broker-
// authoritative sourcing (findOpenPosition / trades ledger) is a later slice. Pure.
function _promoteToInPosition(call, idea, nowMs, nextAt, bumpCount, trade = null) {
    const ps        = call.position_state ?? {}
    const dir       = idea.direction ?? (idea.status === 'short' ? 'short' : 'long')
    // Real broker fill from the trades ledger; fall back to the intended entry until it's captured.
    const fillPrice = _num(trade?.entry?.price) ?? ps.entry?.intended ?? null
    const fillAtMs  = idea.entryTriggeredAt ?? idea.activatedAt ?? nowMs
    const set = {
        status: 'in_position',
        'position_state.entry.fill_price': fillPrice,
        'position_state.entry.fill_at':    new Date(fillAtMs).toISOString(),
        'position_state.entry.size':       idea.quantity ?? ps.entry?.size ?? null,
        'position_state.entry.direction':  dir,
        'position_state.phase':            'running',
        'monitor_state.next_check_at':     nextAt,
        'monitor_state.check_count':       bumpCount,
    }
    const note = `Filled ${call.asset}${fillPrice != null ? ` at ${fillPrice}` : ''} — I'm in. Initial stop ${ps.stop?.initial ?? '?'}; managing from here.`
    const entry = { at: new Date(nowMs).toISOString(), reason: 'entry', phase: 'in_position', price: _num(fillPrice), verdict: null, note, next_check_at: nextAt }
    return { set, entry }
}

// Any status → closed: the reconciler already flipped the idea 'closed' (stop / TP / Hermes exit /
// external). Write the outcome from what the idea carries (realizedPnl / closedReason / closedAt);
// exact exit price + R is refined in a later slice (the idea doesn't store the exit fill). Pure.
function _closeFromIdea(call, idea, nowMs, bumpCount, trade = null) {
    const ps      = call.position_state ?? {}
    // Broker-authoritative from the trades ledger (real entry/exit price + realized P&L); fall back
    // to the stamped fill / idea fields. NOTE: a scaled-out trade's P&L may undercount — the ledger
    // records only the FINAL close's realizedPnl, not intermediate partials (a ledger-wide gap).
    const entryPx = ps.entry?.fill_price ?? _num(trade?.entry?.price) ?? ps.entry?.intended ?? null
    const exitPx  = _num(trade?.exit?.price)
    const dir     = ps.entry?.direction ?? idea.direction ?? 'long'
    const reason  = idea.closedReason ?? trade?.exit?.reason ?? 'broker'
    const r       = _rMultiple(entryPx, exitPx, ps.stop?.initial, dir)   // null exit → null R
    const outcome = {
        exit_price: exitPx,
        r_multiple: r,
        pnl:        trade?.exit?.realizedPnl ?? idea.realizedPnl ?? null,
        reason,
        at:         idea.closedAt ? new Date(idea.closedAt).toISOString() : new Date(nowMs).toISOString(),
    }
    const set = {
        status: 'closed',
        'position_state.outcome':    outcome,
        'monitor_state.check_count': bumpCount,
    }
    const rTxt   = r != null ? `, ${r > 0 ? '+' : ''}${r}R` : ''
    const pnlTxt = outcome.pnl != null ? ` (P&L ${outcome.pnl}${rTxt})` : (rTxt ? ` (${rTxt.slice(2)})` : '')
    const note   = `Position closed on ${call.asset} — ${reason}${pnlTxt}. That's the trade.`
    const entry  = { at: new Date(nowMs).toISOString(), reason: 'close', phase: 'close', price: exitPx, verdict: null, note, next_check_at: null }
    return { set, entry }
}

// R-multiple = signed move / initial risk (|entry − initial stop|). null unless all inputs finite
// and risk > 0. Pure. `dir` flips the sign so a short that fell is positive.
export function _rMultiple(entry, exit, initialStop, dir) {
    if (![entry, exit, initialStop].every(Number.isFinite)) return null
    const risk = Math.abs(entry - initialStop)
    if (!(risk > 0)) return null
    const move = dir === 'short' ? (entry - exit) : (exit - entry)
    return Math.round((move / risk) * 100) / 100
}

// ─── In-position management brain (Phase 5, slice 2) ───────────────────────────────────────────
// A cheap arithmetic gate skips the LLM on obvious holds; a periodic review (every max_gap) keeps a
// thesis check alive even when price is quiet. When the gate trips or a review is due, the four-axis
// in-position read runs (LLM+vision) and, if it wants to act, records a PROPOSAL as pending_action
// (a card). Execution (amending broker orders on user confirm) is slice 3 — slice 2 only proposes.

// Verdict urgency, used to escalate over an already-pending card (a fresh exit_now must fire over a
// pending take_partial; a same-or-lower action must NOT re-fire and spam).
const VERDICT_SEVERITY = { hold: 0, let_run: 1, take_partial: 2, move_stop: 3, exit_now: 4 }

function _minGapMs(cadence) { return (Number(cadence?.min_gap_min) || 1)  * 60_000 }
function _maxGapMs(cadence) { return (Number(cadence?.max_gap_min) || 15) * 60_000 }
function _entryPx(ps)  { return ps?.entry?.fill_price ?? ps?.entry?.intended ?? null }

// Running trade metrics, recomputed every wake (never authored). mae/mfe are R extremes carried
// across wakes (adverse ≤ 0, favorable ≥ 0). Pure.
export function _computeMetrics(ps, price, nowMs) {
    const r       = _rMultiple(_entryPx(ps), price, ps?.stop?.initial, ps?.entry?.direction ?? 'long')
    const prevMae = Number.isFinite(ps?.metrics?.mae) ? ps.metrics.mae : null
    const prevMfe = Number.isFinite(ps?.metrics?.mfe) ? ps.metrics.mfe : null
    const mae = r == null ? prevMae : (prevMae == null ? Math.min(0, r) : Math.min(prevMae, r))
    const mfe = r == null ? prevMfe : (prevMfe == null ? Math.max(0, r) : Math.max(prevMfe, r))
    return { r_multiple_now: r, mae, mfe, updated_at: new Date(nowMs).toISOString() }
}

function _metricsSet(m) {
    return {
        'position_state.metrics.r_multiple_now': m.r_multiple_now,
        'position_state.metrics.mae':            m.mae,
        'position_state.metrics.mfe':            m.mfe,
        'position_state.metrics.updated_at':     m.updated_at,
    }
}

// The cheap gate: an arithmetic flag that makes an LLM look worthwhile. Priority adverse > scale_out
// > breakeven (most urgent first). `null` flag → an obvious hold (skip the LLM). Pure.
export function _positionGate(ps, price) {
    if (!Number.isFinite(price)) return { flag: null }
    const entry       = _entryPx(ps)
    const initialStop = ps?.stop?.initial
    const stopCur     = ps?.stop?.current ?? initialStop
    const isLong      = (ps?.entry?.direction ?? 'long') !== 'short'
    const risk        = (Number.isFinite(entry) && Number.isFinite(initialStop)) ? Math.abs(entry - initialStop) : null
    const band        = risk != null ? 0.25 * risk : null

    // adverse — price pressing the working stop
    if (band != null && Number.isFinite(stopCur)) {
        if (isLong  && price <= stopCur + band) return { flag: 'adverse' }
        if (!isLong && price >= stopCur - band) return { flag: 'adverse' }
    }
    // scale_out — a remaining (un-hit) target touched
    const target = (ps?.targets ?? []).find(t => t?.hit_at == null && Number.isFinite(t?.price) && (isLong ? price >= t.price : price <= t.price))
    if (target) return { flag: 'scale_out', target }
    // breakeven — ≥ +1R and the stop isn't yet protected past entry
    const r = _rMultiple(entry, price, initialStop, ps?.entry?.direction ?? 'long')
    if (r != null && r >= 1) {
        const protectedBE = isLong ? Number(stopCur) >= entry : Number(stopCur) <= entry
        if (!protectedBE) return { flag: 'breakeven' }
    }
    return { flag: null }
}

// A periodic thesis review is due when it's been ≥ max_gap since the last management read (or none
// yet). Keeps the manager honest even while price sits quiet between gate trips. Pure.
export function _reviewDue(ps, nowMs, cadence) {
    const lastAt = Date.parse(ps?.last_management?.at ?? ps?.entry?.fill_at ?? '')
    return !Number.isFinite(lastAt) || (nowMs - lastAt) >= _maxGapMs(cadence)
}

// Clean a management proposal per verdict: snap stop/TP to reference structure, clamp size. Pure.
// `refs` = the call's reference_levels (the snap targets); `isLong` = position side.
export function _finalizePositionProposal(verdict, proposal, refs, isLong, price) {
    if (!proposal || typeof proposal !== 'object') return null
    if (verdict === 'move_stop') {
        const snap = _snapToReference(Number(proposal.new_stop), refs, isLong ? 'below' : 'above', price)
        return { new_stop: snap.price, ref: snap.ref, reason: proposal.reason ?? null }
    }
    if (verdict === 'take_partial') {
        let pct = Number(proposal.size_pct)
        if (!Number.isFinite(pct)) pct = 50
        pct = Math.max(1, Math.min(100, pct))
        return { size_pct: pct, reason: proposal.reason ?? null }
    }
    if (verdict === 'let_run') {
        if (proposal.cancel_tp) return { cancel_tp: true, reason: proposal.reason ?? null }
        const snap = _snapToReference(Number(proposal.new_tp), refs, isLong ? 'above' : 'below', price)
        return { new_tp: snap.price, ref: snap.ref, reason: proposal.reason ?? null }
    }
    if (verdict === 'exit_now') return { reason: proposal.reason ?? null }
    return null
}

// Turn a raw in-position assessment into the persisted $set (+ journal entry + whether to fire a
// management card). A non-hold verdict sets pending_action ONLY when it's new or escalates over an
// already-pending card (severity strictly greater) — anti-spam. A `hold` never clears a pending
// card (the user hasn't acted; the slice-3 handoff resolves it). No stop/target/phase mutation here
// — those change on EXECUTION (slice 3); slice 2 only proposes. Pure.
export function _applyPositionAssessment(call, ps, raw, price, metrics, nowMs, reason) {
    const at       = new Date(nowMs).toISOString()
    const verdict  = ['hold', 'move_stop', 'take_partial', 'exit_now', 'let_run'].includes(raw?.verdict) ? raw.verdict : 'hold'
    const isLong   = (ps?.entry?.direction ?? 'long') !== 'short'
    const proposal = verdict !== 'hold' ? _finalizePositionProposal(verdict, raw.proposal, call?.reference_levels ?? [], isLong, price) : null
    const nextAt   = _computeNextCheckAt(nowMs, raw?.next_check_min, call?.cadence)
    const memo     = raw?.memo_update != null && raw.memo_update !== '' ? String(raw.memo_update) : (ps?.memo ?? '')

    const prior     = ps?.pending_action ?? null
    const sev       = VERDICT_SEVERITY[verdict] ?? 0
    const priorSev  = prior ? (VERDICT_SEVERITY[prior.verdict] ?? 0) : -1
    const setsCard  = verdict !== 'hold' && proposal != null && (!prior || sev > priorSev)
    const pending   = setsCard ? { verdict, proposal, fired_at: at, severity: sev } : prior

    const lastManagement = {
        at, reason, verdict,
        read:          raw?.read ?? null,
        market:        raw?.market ?? null,
        news:          raw?.news ?? null,
        price_action:  raw?.price_action ?? null,
        patterns_seen: Array.isArray(raw?.patterns_seen) ? raw.patterns_seen : [],
        ...(proposal ? { proposal } : {}),
        next_check_at: nextAt,
        memo_update:   raw?.memo_update ?? null,
    }

    const set = {
        ..._metricsSet(metrics),
        'position_state.memo':            memo,
        'position_state.last_management': lastManagement,
        'monitor_state.next_check_at':    nextAt,
        'monitor_state.check_count':      (call?.monitor_state?.check_count ?? 0) + 1,
        ...(setsCard ? { 'position_state.pending_action': pending } : {}),
    }

    const note  = (raw?.read && String(raw.read).trim()) ? String(raw.read).trim() : _managementFallbackNote(verdict)
    const entry = {
        at, reason: 'in_position', phase: 'in_position', price: _num(price), verdict,
        note,
        axes: { market: raw?.market ?? null, news: raw?.news ?? null, price_action: raw?.price_action ?? null, patterns_seen: Array.isArray(raw?.patterns_seen) ? raw.patterns_seen : [] },
        next_check_at: nextAt,
    }
    return { set, entry, fireCard: setsCard, card: setsCard ? { verdict, proposal, reason, read: raw?.read ?? null } : null }
}

function _managementFallbackNote(verdict) {
    switch (verdict) {
        case 'move_stop':    return 'Tightening my protection — proposing a new stop.'
        case 'take_partial': return 'Banking part of this into strength — proposing a partial.'
        case 'exit_now':     return 'The thesis has broken — proposing we get flat now.'
        case 'let_run':      return 'Momentum is strong — proposing we let it run.'
        default:             return 'Read the trade; it\'s working as planned — holding.'
    }
}

// Orchestrate one in-position wake: metrics (always) → cheap gate → (only if tripped/review-due) the
// four-axis management read → persist (+ fire card). Injectable IO for tests.
async function _managePosition(db, call, idea, nowMs, deps) {
    const ps       = call.position_state ?? {}
    const price    = await deps.getPrice(call)
    const metrics  = _computeMetrics(ps, price, nowMs)
    const gate     = _positionGate(ps, price)
    const assessNow = !!gate.flag || _reviewDue(ps, nowMs, call.cadence)

    // Cheap hold: nothing material — update metrics, re-check soon (min_gap), no LLM, no journal spam.
    if (!assessNow) {
        const nextAt = new Date(nowMs + _minGapMs(call.cadence)).toISOString()
        await _persist(db, call.id, {
            ..._metricsSet(metrics),
            'monitor_state.next_check_at': nextAt,
            'monitor_state.check_count':   (call?.monitor_state?.check_count ?? 0) + 1,
        })
        return { reason: 'in_position_idle' }
    }

    const reason = gate.flag ?? 'review'
    const raw = await deps.assessPosition(call, ps, { price, reason, gate, metrics }, deps)
    if (!raw) {
        // Assessment failed — retry soon (min gap), keep metrics fresh.
        const nextAt = new Date(nowMs + _minGapMs(call.cadence)).toISOString()
        await _persist(db, call.id, {
            ..._metricsSet(metrics),
            'monitor_state.next_check_at': nextAt,
            'monitor_state.check_count':   (call?.monitor_state?.check_count ?? 0) + 1,
        }, { at: new Date(nowMs).toISOString(), reason: 'in_position', phase: 'in_position', price: _num(price), verdict: null,
             note: `Went to reassess ${call.asset} but the data/vision call failed — retrying shortly.`, next_check_at: nextAt })
        return { reason, failed: true }
    }

    const { set, entry, fireCard, card } = _applyPositionAssessment(call, ps, raw, price, metrics, nowMs, reason)
    await _persist(db, call.id, set, entry)
    if (fireCard) {
        try { await deps.onManageCard(call, card) }
        catch (err) { logger.warn(LOG, `onManageCard failed for ${call.id}:`, err.message) }
    }
    return { reason, verdict: raw.verdict, fireCard }
}

// ─── Pure decision helpers (unit-tested) ───────────────────────────────────────

// The arithmetic gate. Scan every zone's band; return the FIRST zone price is inside (others
// stay latent), or null. This is what makes multi-zone "long the reclaim OR the pullback" work.
export function _zoneGate(call, price) {
    if (!Number.isFinite(price)) return null
    const zones = Array.isArray(call?.entry_zones) ? call.entry_zones : []
    for (const z of zones) {
        const lo = Number(z?.lower), hi = Number(z?.upper)
        if (Number.isFinite(lo) && Number.isFinite(hi) && price >= lo && price <= hi) return z
    }
    return null
}

// Before active_from → the call's start time hasn't arrived. A PRIMARY time gate that defers
// monitoring entirely (no price fetch, no LLM) until then — the Kairos analog of the idea monitor's
// isTimeBlocked "should I monitor at all" pre-check, and the lower-bound sibling of valid_until.
// No active_from (or unparseable) → never gated. Pure.
export function _isPreActive(call, nowMs) {
    if (!call?.active_from) return false
    const from = Date.parse(call.active_from)
    if (!Number.isFinite(from)) return false
    return nowMs < from
}

// Within EXPIRY_THRESHOLD of valid_until (or already past) → time for the final expiry review.
export function _isExpiring(call, nowMs, thresholdMs = EXPIRY_THRESHOLD_MS) {
    if (!call?.valid_until) return false
    const exp = Date.parse(call.valid_until)
    if (!Number.isFinite(exp)) return false
    return nowMs >= exp - thresholdMs
}

// Clamp the agent's requested gap (minutes) to the call's cadence, return an ISO next_check_at.
export function _computeNextCheckAt(nowMs, requestedMin, cadence) {
    const lo = Number(cadence?.min_gap_min) || 1
    const hi = Number(cadence?.max_gap_min) || 60
    let m = Number(requestedMin)
    if (!Number.isFinite(m)) m = hi
    m = Math.max(lo, Math.min(hi, m))
    return new Date(nowMs + m * 60_000).toISOString()
}

// Status transition from the verdict (+ why we were looking).
export function _nextStatus(verdict, reason) {
    if (verdict === 'enter')      return 'ready'
    if (verdict === 'edit')       return 'expiring'   // edit card fired; awaiting the user
    if (verdict === 'let_expire') return 'expired'
    return reason === 'zone_trip' ? 'watching' : 'waiting'
}

// Actually past valid_until (not merely within the pre-expiry review window, which _isExpiring covers).
export function _isPastExpiry(call, nowMs) {
    if (!call?.valid_until) return false
    const exp = Date.parse(call.valid_until)
    return Number.isFinite(exp) && nowMs >= exp
}

// Reconcile the model's verdict against WHY we assessed + the clock, so two off-menu cases can't
// misbehave:
//   • let_expire on a zone trip would terminally kill a call still inside its validity window —
//     let_expire is only on the menu for an expiry review, so downgrade it to stand_aside.
//   • an expiry review that's actually PAST valid_until but still won't commit (wait/stand_aside)
//     would re-queue to 'waiting' and be re-assessed (chart + vision LLM) every cadence forever —
//     force it to let_expire so the call terminates. Within the pre-expiry window (not yet past),
//     wait/stand_aside stay legitimate. Pure.
export function _effectiveVerdict(verdict, reason, pastExpiry) {
    if (verdict === 'let_expire' && reason !== 'expiry_review') return 'stand_aside'
    if (reason === 'expiry_review' && pastExpiry && verdict !== 'enter' && verdict !== 'edit') return 'let_expire'
    return verdict
}

// Snap a proposed price to the nearest reference level on the correct side of entry, so the
// stop/TP land on pre-mapped structure rather than a conjured number. No suitable level → keep
// the proposed price with ref=null.
export function _snapToReference(price, refs, dir, entry) {
    if (!Number.isFinite(price)) return { price: null, ref: null }
    const list = (Array.isArray(refs) ? refs : []).filter(r => {
        const rp = Number(r?.price)
        if (!Number.isFinite(rp)) return false
        if (dir === 'below') return rp < entry
        if (dir === 'above') return rp > entry
        return true
    })
    if (!list.length) return { price, ref: null }
    let best = list[0], bestD = Math.abs(Number(list[0].price) - price)
    for (const c of list) {
        const d = Math.abs(Number(c.price) - price)
        if (d < bestD) { best = c; bestD = d }
    }
    return { price: Number(best.price), ref: best.id ?? null }
}

// Clean an enter proposal: snap stop/TP to reference structure, clamp size to the user cap,
// compute R:R off the first target. Pure.
export function _finalizeProposal(p, call, zone) {
    if (!p || typeof p !== 'object') return null

    const side    = zone?.side ?? call?.bias ?? 'long'
    const entry   = Number(p.entry)
    const refs    = call?.reference_levels ?? []
    const maxSize = Number(call?.sizing?.max_size) || 0

    // Size: server-authoritative cap. Default to the cap; clamp any proposed size into (0, max].
    let size = Number(p.size)
    if (!Number.isFinite(size) || size <= 0) size = maxSize
    size = Math.min(size, maxSize)

    const stopDir = side === 'short' ? 'above' : 'below'
    const tpDir   = side === 'short' ? 'below' : 'above'
    const stopSnap = _snapToReference(Number(p.stop), refs, stopDir, entry)

    const tps = (Array.isArray(p.take_profit) ? p.take_profit : []).map(t => {
        const s = _snapToReference(Number(t?.price), refs, tpDir, entry)
        return { price: s.price, ref: s.ref }
    })

    const stop    = stopSnap.price
    const firstTp = tps[0]?.price
    const rr = (Number.isFinite(entry) && Number.isFinite(stop) && Number.isFinite(firstTp) && Math.abs(entry - stop) > 0)
        ? Math.round((Math.abs(firstTp - entry) / Math.abs(entry - stop)) * 100) / 100
        : null

    return {
        entry:       Number.isFinite(entry) ? entry : null,
        stop:        Number.isFinite(stop) ? stop : null,
        stop_ref:    stopSnap.ref,
        take_profit: tps,
        size,
        rr,
        rationale:   p.rationale ?? null,
    }
}

// Turn a raw assessment into the persisted $set patch (+ whether to fire a card). Pure.
export function _applyAssessment(call, zone, raw, nowMs, reason) {
    // Resolve the effective verdict first (guards the two off-menu cases in _effectiveVerdict),
    // then derive proposal / status / card from it — never from the raw model verdict.
    const verdict  = _effectiveVerdict(raw.verdict, reason, _isPastExpiry(call, nowMs))
    const nextAt   = _computeNextCheckAt(nowMs, raw.next_check_min, call?.cadence)
    const proposal = verdict === 'enter' ? _finalizeProposal(raw.proposal, call, zone) : null
    const status   = _nextStatus(verdict, reason)
    // Running memo: update only when the assessment provides one, else carry the prior note.
    const memo = raw.memo_update != null && raw.memo_update !== ''
        ? String(raw.memo_update)
        : (call?.monitor_state?.memo ?? '')

    const lastAssessment = {
        at:            new Date(nowMs).toISOString(),
        reason,
        zone_id:       zone?.id ?? null,
        timeframe_used: raw.timeframe_used ?? null,
        read:          raw.read ?? null,
        market:        raw.market ?? null,
        news:          raw.news ?? null,
        price_action:  raw.price_action ?? null,
        patterns_seen: Array.isArray(raw.patterns_seen) ? raw.patterns_seen : [],
        verdict,
        ...(proposal ? { proposal } : {}),
        ...(raw.edit_proposal ? { edit_proposal: raw.edit_proposal } : {}),
        next_check_at: nextAt,
        memo_update:   raw.memo_update ?? null,
    }

    const set = {
        status,
        'monitor_state.armed_zone_id':    zone?.id ?? call?.monitor_state?.armed_zone_id ?? null,
        'monitor_state.chosen_timeframe': raw.timeframe_used ?? null,
        'monitor_state.check_count':      (call?.monitor_state?.check_count ?? 0) + 1,
        'monitor_state.memo':             memo,
        'monitor_state.next_check_at':    nextAt,
        'monitor_state.last_assessment':  lastAssessment,
    }

    // 'let_expire' now fires a card too (the expiry notification) — previously it was a silent
    // terminal 'expired'. enter → ready card; edit → re-map card; let_expire → expired card.
    return { set, fireCard: ['enter', 'edit', 'let_expire'].includes(verdict), lastAssessment }
}

// Cheap-path reschedule (no assessment ran). Idle → check further out (max gap); after a failed
// assessment → retry soon (min gap). Bumps the check counter. Pure $set patch.
export function _scheduledPatch(call, nowMs, short = false) {
    const cadence = call?.cadence ?? {}
    const gap = short ? (Number(cadence.min_gap_min) || 1) : (Number(cadence.max_gap_min) || 60)
    return {
        // No zone tripped (or market closed) → the call isn't actively being assessed, so a stale
        // 'watching' returns to 'waiting'. Keeps 'watching' meaning exactly "price in a zone now".
        ...(call?.status === 'watching' ? { status: 'waiting' } : {}),
        'monitor_state.check_count':   (call?.monitor_state?.check_count ?? 0) + 1,
        'monitor_state.next_check_at': new Date(nowMs + gap * 60_000).toISOString(),
    }
}

// ─── Timeline / monologue (the monitor journal) ────────────────────────────────
// An append-only, first-person log of EVERY wake — the "brain" the call pop-out reads. Cheap
// wakes (closed / not-near-a-zone) get a one-line arithmetic note; a real assessment carries the
// model's own first-person `read` + the four-axis detail. Kept compact and capped on the doc.
// Bumped 50→80 (Phase 5): the journal now spans readiness + entry + the in-position management era,
// so the rolling monologue needs more room before old idle wakes roll off. The durable factual
// spine (fill / actions / outcome) lives structurally in position_state and never rolls off.
const TIMELINE_MAX = 80

function _fmt(n) { return Number.isFinite(Number(n)) ? String(Number(n)) : '?' }
function _num(n) { return Number.isFinite(Number(n)) ? Number(n) : null }

// "188–189" (single) or "188–189, 192–193" (multi). { text, multi }.
export function _zonesLabel(call) {
    const zones = Array.isArray(call?.entry_zones) ? call.entry_zones : []
    const parts = zones
        .filter(z => Number.isFinite(Number(z?.lower)) && Number.isFinite(Number(z?.upper)))
        .map(z => `${_fmt(z.lower)}–${_fmt(z.upper)}`)
    return { text: parts.length ? parts.join(', ') : '(no zones)', multi: parts.length > 1 }
}

// Whole-minute gap between now and an ISO next-check (≥1), or null if unparseable.
function _gapMin(nextAt, nowMs) {
    const t = Date.parse(nextAt)
    if (!Number.isFinite(t)) return null
    return Math.max(1, Math.round((t - nowMs) / 60_000))
}

// What the assessment deterministically pulls (mirrors _defaultAssess) — the "fetched" line.
function _fetchedLabel(call) {
    const tf = call?.timeframe_ladder?.at(-1) ?? '15min'
    return `chart ${tf} (vwap+ema50+vol) · ~30 candles · price`
}

// When the model gives no first-person note, synthesize one from the verdict so the log still reads.
function _verdictFallbackNote(raw) {
    switch (raw?.verdict) {
        case 'enter':       return 'This finally looks ready — proposing an entry.'
        case 'wait':        return "In the zone, but the trigger isn't here yet — waiting."
        case 'stand_aside': return 'Conditions are against this one right now — standing aside.'
        case 'let_expire':  return 'Nothing materialized — letting it expire.'
        case 'edit':        return 'The setup has drifted — proposing a re-map.'
        default:            return 'Read the chart; no change.'
    }
}

// Build one compact append-only journal entry for a wake. Pure — `at` derives from nowMs so tests
// are deterministic. reason ∈ pre_active | closed | scheduled | zone_trip | expiry_review.
export function _timelineEntry(reason, { nowMs, price = null, zone = null, call, raw = null, nextAt = null, fetched = null, failed = false }) {
    const at  = new Date(nowMs).toISOString()
    const gap = _gapMin(nextAt, nowMs)

    if (reason === 'closed') {
        return { at, reason, price: null, verdict: null,
            note: `Market's closed for ${call?.asset ?? 'this asset'} — holding. I'll look again at the open.`,
            next_check_at: nextAt }
    }
    if (reason === 'pre_active') {
        return { at, reason, price: null, verdict: null,
            note: `Not live yet for ${call?.asset ?? 'this call'} — I start watching at ${call?.active_from ?? '?'}.`,
            next_check_at: nextAt }
    }
    if (reason === 'scheduled') {
        const zl = _zonesLabel(call)
        return { at, reason, price: _num(price), verdict: null,
            note: `Price ${_fmt(price)} is outside my zone${zl.multi ? 's' : ''} ${zl.text}. No setup forming${gap ? ` — checking back in ${gap}m` : ''}.`,
            next_check_at: nextAt }
    }
    if (failed) {
        return { at, reason, price: _num(price), verdict: null,
            note: `Went to read ${call?.asset ?? 'the chart'} but the data/vision call failed — retrying shortly.`,
            next_check_at: nextAt }
    }
    // A real assessment (zone tripped or expiry review) — the model's own read + four-axis detail.
    return {
        at, reason,
        price:   _num(price),
        zone_id: zone?.id ?? null,
        fetched,
        verdict: raw?.verdict ?? null,
        note:    (raw?.read && String(raw.read).trim()) ? String(raw.read).trim() : _verdictFallbackNote(raw),
        axes: {
            market:        raw?.market ?? null,
            news:          raw?.news ?? null,
            price_action:  raw?.price_action ?? null,
            patterns_seen: Array.isArray(raw?.patterns_seen) ? raw.patterns_seen : [],
        },
        next_check_at: nextAt,
    }
}

// ─── Default IO deps (real price / LLM assessment / card) ───────────────────────
const _deps = {
    getPrice:    _defaultGetPrice,
    assess:      _defaultAssess,
    onCard:      _defaultOnCard,
    isAssetOpen: (asset, assetClass) => isAssetOpen(asset, assetClass),
    nextOpenMs:  (asset, assetClass) => getMarketStatus(asset, assetClass).nextOpenMs,
    // The linked idea (broker-authoritative, maintained by the execution reconciler) — Hermes reads
    // it to reconcile the call's position lifecycle (Phase 5). Null id / read failure → null.
    getIdea:     async (id) => { if (!id) return null; try { return await (await getDb()).collection('ideas').findOne({ id }) } catch { return null } },
    // The ledger trade for the idea's main position (real entry/exit price + realized P&L) — the
    // broker-authoritative source for the close outcome (slice 4). Null when not yet captured.
    getTrade:    async (idea) => {
        const slot = (idea?.brokerOrders ?? []).find(b => b?.positionId != null)
        if (!slot) return null
        try { return await (await getDb()).collection('trades').findOne({ accountId: String(slot.accountId), positionId: String(slot.positionId) }) } catch { return null }
    },
    // The in-position four-axis management read (slice 2) and the management-card delivery. onManage
    // logs for now — real notify + user-confirm execution is slice 3 (mirrors Phase 2→3 for onCard).
    assessPosition: _defaultAssessPosition,
    onManageCard:   _defaultOnManageCard,
}

async function _defaultGetPrice(call) {
    try {
        const q = await getQuote(call.asset)
        const p = Number(q?.price ?? q?.regularMarketPrice ?? q?.last ?? q?.c)
        if (Number.isFinite(p)) return p
    } catch { /* fall through to candles */ }
    try {
        const rows = await getTickerAggregates(String(call.asset).toUpperCase(), { timeSpan: 'minute', multiplier: 1, from: Date.now() - 3 * 24 * 60 * 60 * 1000 })
        const last = rows?.at(-1)
        if (Number.isFinite(last?.close)) return last.close
    } catch { /* give up */ }
    return null
}

// Post the readiness/expiry card to social chat (notify + route to the call pop-out). `enter`
// → "ready to enter"; `edit`/`let_expire` → the expiry card (re-map or delete). The fresh
// `assessment` carries the proposal / edit rationale (the persisted doc may lag). Best-effort:
// a notify failure must never wedge the monitor loop.
async function _defaultOnCard(call, assessment) {
    logger.info(LOG, 'READINESS CARD', { id: call.id, asset: call.asset, verdict: assessment?.verdict, entry: assessment?.proposal?.entry })
    const verdict = assessment?.verdict
    try {
        if (verdict === 'enter')            await notifyCallReady(call, assessment)
        else if (verdict === 'edit')        await notifyCallExpiry(call, 'edit', assessment?.edit_proposal?.why ?? null)
        else if (verdict === 'let_expire')  await notifyCallExpiry(call, 'expired')
    } catch (err) {
        logger.warn(LOG, `onCard notify failed for ${call.id}:`, err.message)
    }
}

// ─── Real four-axis assessment (LLM + vision) — mocked in unit tests ───────────
const _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const ASSESS_MODEL    = 'claude-sonnet-4-6'
const ALLOWED_MODELS  = new Set(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8'])
const ALLOWED_EFFORTS = new Set(['off', 'low', 'high'])
// The visible reply is a small JSON object, but when thinking is on the hidden reasoning tokens
// ALSO count toward max_tokens — so give generous headroom to avoid truncating the JSON.
const ASSESS_MAX_TOKENS          = 900
const ASSESS_MAX_TOKENS_THINKING = 16_000

// Map the reasoning-effort knob onto Anthropic adaptive extended thinking — mirrors
// anthropic.provider.js. 'off'/invalid → null (no thinking block, zero reasoning cost). Adaptive
// (NOT budget_tokens, which 400s on Opus 4.8) + effort is supported across all allowed models. Pure.
export function _thinkingConfig(effort) {
    return (effort === 'low' || effort === 'high')
        ? { thinking: { type: 'adaptive' }, output_config: { effort } }
        : null
}

// Hermes (this monitor) runs under the user's AI preferences: read their synced `hermesModel` +
// `hermesReasoning` from the account preferences and use them for the readiness assessment. Falls
// back to Sonnet / no-thinking when unset, invalid, or unreadable. All allowed models are
// vision-capable, so the chart read is safe whichever the user picks.
async function _hermesRouting(userId) {
    if (!userId) return { model: ASSESS_MODEL, reasoningEffort: 'off' }
    try {
        const prefs = await userService.getPreferences(userId)
        return {
            model:           ALLOWED_MODELS.has(prefs?.hermesModel)      ? prefs.hermesModel     : ASSESS_MODEL,
            reasoningEffort: ALLOWED_EFFORTS.has(prefs?.hermesReasoning) ? prefs.hermesReasoning : 'off',
        }
    } catch {
        return { model: ASSESS_MODEL, reasoningEffort: 'off' }
    }
}

// Pull the first text block from an assessment response. With extended thinking on, content[0] is a
// thinking block, so a bare content[0].text would miss the JSON — find the text block explicitly. Pure.
export function _assessText(msg) {
    const block = (msg?.content ?? []).find(b => b?.type === 'text')
    return block?.text ?? ''
}

const _ASSESS_SYSTEM = `You are Kairos, a discretionary day/swing trader running a readiness check on a pre-built trade "call".
You are given the call (zones, reference levels, patterns), a rendered chart image, recent candles, the current price, and why you were woken.
Decide if NOW is a good moment to enter around the armed zone. Weight price action over indicators. Be strict — most checks should NOT be "enter".
Assess four axes: market conditions, news/catalyst, price action (from the chart), and whether the mapped patterns are actually happening.
On an expiry_review, choose enter (it finally looks good), edit (re-map/roll — provide edit_proposal), or let_expire.
Always include "read": ONE short, plain first-person sentence — what you see right now and what you're doing about it (e.g. "Price is coiling just under the zone, no trigger yet — I'll keep waiting."). This is your live monologue, so keep it human and specific.
Output ONLY a JSON object, no prose:
{"timeframe_used":"15min","read":"<one first-person sentence>","market":{"read":"...","score":"supportive|neutral|adverse"},"news":{"read":"...","score":"supportive|neutral|adverse|blocking"},"price_action":{"read":"...","strength":"strong|weak|mixed"},"patterns_seen":[{"id":"p1","present":true,"note":"..."}],"verdict":"enter|wait|stand_aside|let_expire|edit","proposal":{"entry":0,"stop":0,"take_profit":[{"price":0}],"rationale":"..."},"next_check_min":15,"memo_update":"..."}
Include "proposal" only when verdict is "enter"; include "edit_proposal":{"why":"...","changes":{}} only when verdict is "edit".`

export async function _defaultAssess(call, zone, ctx, _d) {
    try {
        const tf = call.timeframe_ladder?.at(-1) ?? '15min'
        const [png, candlesText] = await Promise.all([
            fetchChartImage(String(call.asset).toUpperCase(), tf, buildStudies('vwap, ema(50), volume')).catch(() => null),
            _candlesText(call.asset, tf).catch(() => ''),
        ])

        const userText = [
            `CALL: ${JSON.stringify({ asset: call.asset, trade_type: call.trade_type, bias: call.bias, entry_zones: call.entry_zones, reference_levels: call.reference_levels, patterns: call.patterns, timeframe_ladder: call.timeframe_ladder, valid_until: call.valid_until })}`,
            `ARMED ZONE: ${zone ? JSON.stringify(zone) : 'none (expiry review)'}`,
            `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
            `REASON WOKEN: ${ctx.reason}`,
            `PRIOR MEMO: ${call.monitor_state?.memo || '(none)'}`,
            candlesText ? `RECENT CANDLES (${tf}):\n${candlesText}` : '',
        ].filter(Boolean).join('\n\n')

        const content = png
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: userText }]
            : userText

        const { model, reasoningEffort } = await _hermesRouting(call.user_id)
        const thinking = _thinkingConfig(reasoningEffort)
        const msg = await _client.messages.create({
            model,
            max_tokens: thinking ? ASSESS_MAX_TOKENS_THINKING : ASSESS_MAX_TOKENS,
            system: [{ type: 'text', text: _ASSESS_SYSTEM, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content }],
            ...(thinking ?? {}),
        })
        return extractFirstJSON(_assessText(msg))
    } catch (err) {
        logger.warn(LOG, `assessment failed for ${call.id}:`, err.message)
        return null
    }
}

async function _candlesText(asset, tf) {
    const spec = tf === 'day' ? { timeSpan: 'day', multiplier: 1 }
        : tf === '1hr' || tf === '4hr' ? { timeSpan: 'hour', multiplier: 1 }
        : { timeSpan: 'minute', multiplier: tf === '5min' ? 5 : tf === '30min' ? 30 : 15 }
    const rows = await getTickerAggregates(String(asset).toUpperCase(), { ...spec, from: Date.now() - 10 * 24 * 60 * 60 * 1000 })
    return (rows ?? []).slice(-30).map(c => {
        const d = new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
        return `${d} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`
    }).join('\n')
}

// ─── In-position management assessment (LLM + vision) — mocked in unit tests ───
// Post the management card to social chat (routes to the call pop-out, where the user accepts or
// dismisses → the manageCall handoff executes it). Best-effort: a notify failure must never wedge
// the monitor loop.
async function _defaultOnManageCard(call, card) {
    logger.info(LOG, 'MANAGEMENT CARD', { id: call.id, asset: call.asset, verdict: card?.verdict, proposal: card?.proposal })
    try { await notifyCallManage(call, card) }
    catch (err) { logger.warn(LOG, `onManageCard notify failed for ${call.id}:`, err.message) }
}

const _POSITION_SYSTEM = `You are Kairos, a discretionary day/swing trader MANAGING a live position you already entered (not looking for a new one).
You are given the original call (thesis, patterns, reference levels), the live position (entry fill, working stop, targets, what's been taken, running R-multiple/memo), the current price, a rendered chart, recent candles, and why you were woken.
Manage it like a pro: LET WINNERS RUN, cut when the THESIS breaks, and do NOT micro-manage. Most checks should be "hold". Re-check the ORIGINAL thesis and mapped patterns against what price is doing NOW; weight price action over indicators.
Choose ONE verdict:
- hold: nothing to do (the DEFAULT — bias strongly toward this).
- move_stop: trail / move the stop to protect (breakeven only after a clear +1R, or up to fresh structure). proposal.new_stop.
- take_partial: bank part of the position into a target/strength. proposal.size_pct (1-100).
- exit_now: the thesis is broken or invalidated — get flat now, don't wait for the stop. proposal.reason.
- let_run: momentum is strong into/through the final target — extend or cancel the take-profit. proposal.new_tp OR proposal.cancel_tp:true.
Always include "read": ONE short, plain first-person sentence — what you see and what you're doing.
Output ONLY a JSON object, no prose:
{"read":"<one first-person sentence>","market":{"read":"...","score":"supportive|neutral|adverse"},"news":{"read":"...","score":"supportive|neutral|adverse|blocking"},"price_action":{"read":"...","strength":"strong|weak|mixed"},"patterns_seen":[{"id":"p1","present":true,"note":"..."}],"verdict":"hold|move_stop|take_partial|exit_now|let_run","proposal":{"new_stop":0,"size_pct":0,"new_tp":0,"cancel_tp":false,"reason":"..."},"next_check_min":15,"memo_update":"..."}
Include "proposal" only when the verdict is NOT "hold" (only the fields that verdict needs).`

export async function _defaultAssessPosition(call, ps, ctx, _d) {
    try {
        const tf = call.timeframe_ladder?.at(-1) ?? '15min'
        const [png, candlesText] = await Promise.all([
            fetchChartImage(String(call.asset).toUpperCase(), tf, buildStudies('vwap, ema(50), volume')).catch(() => null),
            _candlesText(call.asset, tf).catch(() => ''),
        ])

        const userText = [
            `CALL: ${JSON.stringify({ asset: call.asset, trade_type: call.trade_type, bias: call.bias, thesis: call.thesis, patterns: call.patterns, reference_levels: call.reference_levels })}`,
            `POSITION: ${JSON.stringify({ entry: ps.entry, stop: ps.stop, targets: ps.targets, taken: ps.taken, phase: ps.phase })}`,
            `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
            `R-MULTIPLE NOW: ${ctx.metrics?.r_multiple_now ?? 'unknown'}`,
            `REASON WOKEN: ${ctx.reason}`,
            `PENDING CARD: ${ps.pending_action ? JSON.stringify(ps.pending_action) : '(none)'}`,
            `PRIOR MEMO: ${ps.memo || '(none)'}`,
            candlesText ? `RECENT CANDLES (${tf}):\n${candlesText}` : '',
        ].filter(Boolean).join('\n\n')

        const content = png
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: userText }]
            : userText

        const { model, reasoningEffort } = await _hermesRouting(call.user_id)
        const thinking = _thinkingConfig(reasoningEffort)
        const msg = await _client.messages.create({
            model,
            max_tokens: thinking ? ASSESS_MAX_TOKENS_THINKING : ASSESS_MAX_TOKENS,
            system: [{ type: 'text', text: _POSITION_SYSTEM, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content }],
            ...(thinking ?? {}),
        })
        return extractFirstJSON(_assessText(msg))
    } catch (err) {
        logger.warn(LOG, `position assessment failed for ${call.id}:`, err.message)
        return null
    }
}

