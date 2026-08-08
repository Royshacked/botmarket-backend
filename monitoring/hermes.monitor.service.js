import { getDb } from '../providers/mongodb.provider.js'
import { PAST_ENTRY_LEGACY, INVALIDATION } from '../services/entity/vocabulary.js'
import { ENTITIES } from '../services/entity/entityCollection.js'
import { isAssetOpen, getMarketStatus } from '../services/market.service.js'
import { logger } from '../services/logger.service.js'
import { notifyCallReady, notifyCallExpiry, notifyCallManage, notifyCallReentry } from '../services/tradeNotify.service.js'
import { fetchLastPrice } from './monitorUtils.js'
import { createDueLoop, makePersist } from './dueLoop.js'
import { journalEntry, zonesLabel, failNote } from './monitorJournal.js'
import {
    isPreActive, isExpiring, isPastExpiry, effectiveVerdict, nextStatus, clampGap, gradedGap,
    hasEditProposal,
} from './readinessGates.js'
import { withTimeout } from '../services/timeout.util.js'
import { toNum } from '../services/format.util.js'
import { COLLECTION as TRADES } from '../services/tradeCapture.service.js'
import { _defaultAssess, _defaultAssessPosition, _defaultAssessReentry, _thinkingConfig, _assessText, _formatHeadlines, _formatEventRisk, _marketBlock, _isMarketSensitive, _applyEntryConfirmation, _allText, _chartTool, _validChartTf, _structureTools, _institutionalTools, _modeLensBlock, _handleAssessToolUses } from './hermes.assess.js'

// The LLM assessment IO lives in hermes.assess.js (wired into _deps below). Re-exported here
// under their historical names so the existing unit tests import path is unchanged.
export { _thinkingConfig, _assessText, _formatHeadlines, _formatEventRisk, _marketBlock, _isMarketSensitive, _applyEntryConfirmation, _allText, _chartTool, _validChartTf, _structureTools, _institutionalTools, _modeLensBlock, _handleAssessToolUses }

// Hermes — the Kairos-call readiness monitor: a self-scheduling readiness loop (docs/desks/kairos-hermes.md,
// Phase 2). Its own tick, its own collection (`kairos_calls`), sharing NO mutable state with Minos
// (the live idea monitor).
// Design: a CHEAP arithmetic gate (is price inside a mapped zone?) runs every wake; the EXPENSIVE
// four-axis LLM assessment fires only when a zone is tripped or the call is near expiry. Each
// assessment writes back the verdict + a self-chosen next_check_at (clamped to the call's cadence)
// + a running memo carried across wakes. Pre-entry readiness only — hands off at the enter card.

const LOG          = '[hermes.monitor]'
const COLLECTION   = ENTITIES   // calls now live in the shared entities collection as kind:'call'
const KIND_CALL    = 'call'
const POLL_INTERVAL_MS = 60_000
// Only this is re-checked by the readiness loop. `expiry_review` is triggered TIME-based off it
// (via _isExpiring). A call whose thesis has gone stale STAYS 'looking' — the staleness lives on
// the invalidation axis, which latches, so the edit card cannot spam.
// Exported so the WRITER can be pinned to it. This list and normalizeCall's saved status are one
// decision spelled in two files, and when they drifted apart (the convergence moved this to
// 'looking' and left the writer on 'waiting') nothing failed — calls were simply saved into a state
// no loop reads, and sat there looking exactly like calls being watched. A test asserts they agree.
export const ACTIVE_STATUSES = ['looking']
// Post-confirm statuses routed to the position path (NOT the zone-gate readiness path). P3b: the
// call carries its own execution, so its status CONVERGES to the execution vocab after confirm —
// 'hit' = order placed / awaiting fill; 'long'/'short' = live (reconciler-set on fill) and managed.
// Promotion (awaiting→in-position) is detected by position_state.entry.fill_at, not a status name.
// 'confirmed'/'in_position' are the PRE-P3b spellings, kept so any document still carrying them
// keeps being managed rather than dropping out of the loop; they never collide with idea statuses.
// Nothing writes them any more — a confirmed call converges to the execution vocab above.
const POSITION_STATUSES = PAST_ENTRY_LEGACY
const EXPIRY_THRESHOLD_MS = 15 * 60_000   // run the final "expiry review" within 15m of valid_until
// A single check must never wedge the loop. If any IO inside _checkCall (vision assess / chart /
// price fetch) hangs with no timeout, the awaited call never returns, `_running` stays true, and
// every later tick skips forever. Bounding each check lets a hung one reject so the loop recovers.
const CHECK_TIMEOUT_MS = 90_000
// How long the rolling monologue runs. 50→80 (Phase 5): the journal spans readiness + entry + the
// in-position management era, so it needs more room before old idle wakes roll off. The durable
// factual spine (fill / actions / outcome) lives structurally in position_state and never rolls off.
// Declared up here with the other constants because the shared writer is built at module load.
const TIMELINE_MAX = 80

// The wake-up chore lives in dueLoop.js — find what's due, claim it against a lease, check it
// under a timeout. What stays here is only what makes this Hermes's loop: the kind and the statuses.
const _loop = createDueLoop({
    collection: COLLECTION,
    kind:       KIND_CALL,   // entities holds other kinds too; without this the tick would pick them up
    statuses:   [...ACTIVE_STATUSES, ...POSITION_STATUSES],
    check:      async (call, nowMs) => { const db = await getDb(); return _checkCall(db, call, nowMs, _deps) },
    intervalMs: POLL_INTERVAL_MS,
    checkTimeoutMs: CHECK_TIMEOUT_MS,
    log: LOG, name: 'kairos monitor',
})

export const hermesService = { start: _loop.start, stop: _loop.stop }

// Race a promise against a timeout so a hung await can't wedge the loop. Shared impl lives in
// monitorUtils (used by the loop itself too); re-exported here under the historical name for tests.
export const _withTimeout = withTimeout

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
        const patch = _scheduledPatch(call, nowMs)
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
        const patch  = _scheduledPatch(call, nowMs)
        const openMs = deps.nextOpenMs?.(call.asset, call.asset_class)
        if (Number.isFinite(openMs) && openMs > nowMs) patch['monitor_state.next_check_at'] = new Date(openMs).toISOString()
        const entry = _timelineEntry('closed', { nowMs, call, nextAt: patch['monitor_state.next_check_at'] })
        await _persist(db, call.id, patch, entry)
        return { reason: 'closed' }
    }

    const price  = await deps.getPrice(call)
    const zone   = Number.isFinite(price) ? _zoneGate(call, price) : null

    const reason = expiring ? 'expiry_review' : (zone ? 'zone_trip' : 'scheduled')

    // Not near a zone and not expiring. Three outcomes, cheapest-first:
    //   1) anchor not seeded yet → seed it to the current price (no LLM), reschedule.
    //   2) price has moved materially AWAY from every zone (throttled) → ONE full visual "momentum
    //      pulse" read that can re-map the call (Tier 2) — catches a break the plan never mapped.
    //   3) otherwise → the cheap proximity-aware reschedule (no LLM).
    if (reason === 'scheduled') {
        const anchored = Number.isFinite(Number(call?.monitor_state?.pulse_anchor_px))
        if (!anchored && Number.isFinite(price)) {
            const patch = _scheduledPatch(call, nowMs, false, price)
            patch['monitor_state.pulse_anchor_px'] = price   // seed the pulse anchor on first sight
            const entry = _timelineEntry('scheduled', { nowMs, price, call, nextAt: patch['monitor_state.next_check_at'] })
            await _persist(db, call.id, patch, entry)
            return { reason }
        }

        if (_shouldPulse(call, price, nowMs)) {
            const raw = await deps.assess(call, null, { reason: 'momentum_pulse', price }, deps)
            // Re-anchor + stamp the throttle on EVERY pulse (success or fail) so it can't re-fire until
            // price makes a fresh move and the time floor passes.
            const stamp = (set) => {
                set['monitor_state.pulse_anchor_px'] = price
                set['monitor_state.last_pulse_at']   = new Date(nowMs).toISOString()
                return set
            }
            if (!raw || raw._failReason) {
                const patch = stamp(_scheduledPatch(call, nowMs, false, price))
                const entry = _timelineEntry('momentum_pulse', { nowMs, price, call, nextAt: patch['monitor_state.next_check_at'], failed: true, failReason: raw?._failReason })
                await _persist(db, call.id, patch, entry)
                return { reason: 'momentum_pulse', failed: true }
            }
            if (raw.verdict && !_READINESS_VERDICTS.has(raw.verdict)) {
                logger.warn(LOG, `off-menu pulse verdict "${raw.verdict}" for ${call.id} — treating as wait`)
            }
            // v1: a pulse may ONLY re-map (edit) or do nothing — never a direct enter (its proposed
            // levels aren't in the call yet, so _finalizeProposal would snap to stale reference_levels).
            const coerced = (raw.verdict === 'edit' && _hasEditProposal(raw)) ? raw : { ...raw, verdict: 'wait' }
            const { set, fireCard, lastAssessment } = _applyAssessment(call, null, coerced, nowMs, 'momentum_pulse')
            stamp(set)
            const entry = _timelineEntry('momentum_pulse', { nowMs, price, zone: null, call, raw: coerced, nextAt: set['monitor_state.next_check_at'], fetched: _fetchedLabel(call) })
            await _persist(db, call.id, set, entry)
            if (fireCard) {
                try { await deps.onCard(call, lastAssessment) }
                catch (err) { logger.warn(LOG, `onCard (pulse) failed for ${call.id}:`, err.message) }
            }
            return { reason: 'momentum_pulse', verdict: coerced.verdict, fireCard }
        }

        const patch = _scheduledPatch(call, nowMs, false, price)
        const entry = _timelineEntry('scheduled', { nowMs, price, call, nextAt: patch['monitor_state.next_check_at'] })
        await _persist(db, call.id, patch, entry)
        return { reason }
    }

    // Expensive path: the four-axis readiness read (LLM + vision).
    const raw = await deps.assess(call, zone, { reason, price }, deps)
    if (!raw || raw._failReason) {
        // Assessment failed — retry soon (min cadence) rather than dropping the call.
        const patch = _scheduledPatch(call, nowMs, true)
        const entry = _timelineEntry(reason, { nowMs, price, call, nextAt: patch['monitor_state.next_check_at'], failed: true, failReason: raw?._failReason })
        await _persist(db, call.id, patch, entry)
        return { reason, failed: true }
    }

    if (raw.verdict && !_READINESS_VERDICTS.has(raw.verdict)) {
        logger.warn(LOG, `off-menu readiness verdict "${raw.verdict}" for ${call.id} — treating as wait`)
    }
    const { set, fireCard, lastAssessment } = _applyAssessment(call, zone, raw, nowMs, reason)
    if (Number.isFinite(price)) set['monitor_state.pulse_anchor_px'] = price   // re-anchor the pulse: we just had eyes in a zone
    const entry = _timelineEntry(reason, { nowMs, price, zone, call, raw, nextAt: set['monitor_state.next_check_at'], fetched: _fetchedLabel(call) })
    await _persist(db, call.id, set, entry)
    if (fireCard) {
        try { await deps.onCard(call, lastAssessment) }
        catch (err) { logger.warn(LOG, `onCard failed for ${call.id}:`, err.message) }
    }
    return { reason, verdict: raw.verdict, fireCard }
}

// The wake's write, from the shared writer (dueLoop.makePersist): the $set plus the journal line,
// appended and capped. The threaded `db` is handed straight through — this file passes a connection
// to every call site, and its tests inject a fake one there.
const _write = makePersist({ collection: COLLECTION, timelineMax: TIMELINE_MAX, log: LOG })
async function _persist(db, id, set, logEntry = null) {
    return _write(id, set, logEntry, db)
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
    // P2: a STOP-out (not a TP / manual exit) may leave the THESIS intact → offer a discretionary
    // re-entry. A TP means the trade worked (no offer); a manual/Hermes exit is a deliberate close.
    if (rec.set?.status === 'closed' && _isStopOut(rec.set['position_state.outcome'])) {
        await _maybeOfferReentry(db, call, rec.set['position_state.outcome'], nowMs, deps)
    }
    return { reason: 'position', status: rec.set.status ?? call.status }
}

// Was this close a STOP-out (trade invalidation hit), i.e. a candidate for a re-entry offer? A `tp`
// close means the trade worked; a `manual` exit was deliberate — neither offers re-entry. An unlabeled
// broker close that was clearly adverse (negative R) is treated as a stop. Pure.
export function _isStopOut(outcome) {
    const reason = String(outcome?.reason ?? '').toLowerCase()
    if (reason === 'stop') return true
    if ((reason === 'broker' || reason === '') && Number(outcome?.r_multiple) < 0) return true
    return false
}

// Run the one-shot re-entry thesis check at a stop-out and, if the thesis is INTACT, fire the
// re-entry card (Kairos-voiced, to social chat) + stamp a marker. If the thesis is broken (or the read
// fails), just journal and leave the call closed. The user makes the actual re-enter/close decision;
// there is no coded re-entry budget — a human tap is the budget. Never throws (best-effort IO).
async function _maybeOfferReentry(db, call, outcome, nowMs, deps) {
    const at = new Date(nowMs).toISOString()
    let read = null
    try { read = await deps.assessReentry(call, outcome, { nowMs }) }
    catch (err) { logger.warn(LOG, `reentry read failed for ${call.id}:`, err.message); read = null }

    if (!read || read._failReason || read.thesis_alive !== true) {
        const note = read?.thesis_alive === false
            ? `Stopped out on ${call.asset} and the thesis looks broken too — standing down, not re-entering.`
            : `Stopped out on ${call.asset}; couldn't assess a re-entry — leaving it closed.`
        await _persist(db, call.id,
            { 'position_state.reentry': { offered: false, at, thesis_alive: read?.thesis_alive ?? null } },
            { at, reason: 'reentry', phase: 'close', verdict: null, note, next_check_at: null })
        return { offered: false }
    }

    await _persist(db, call.id,
        { 'position_state.reentry': { offered: true, at, why: read.why ?? null } },
        { at, reason: 'reentry', phase: 'close', verdict: null,
          note: `Stopped on ${call.asset}, but the thesis still looks intact — offering a re-entry.`, next_check_at: null })
    try { await deps.onReentry(call, read, outcome) }
    catch (err) { logger.warn(LOG, `onReentry notify failed for ${call.id}:`, err.message) }
    return { offered: true }
}

// Pure. Decide the call's next state from the linked idea's status. Returns { set, entry } where
// `entry` is a journal line to append (or null on an idle wake). The journal is UNIFIED — these
// entries append to the same monitor_state.timeline as the pre-entry readiness wakes.
export function _reconcilePosition(call, idea, nowMs, trade = null) {
    const cadenceMs = (Number(call?.cadence?.max_gap_min) || 15) * 60_000
    const nextAt    = new Date(nowMs + cadenceMs).toISOString()
    const bumpCount = (call?.monitor_state?.check_count ?? 0) + 1
    const idle = { set: { 'monitor_state.next_check_at': nextAt, 'monitor_state.check_count': bumpCount }, entry: null }

    if (!idea) return idle   // self-lookup empty (shouldn't happen post-confirm) — look again next cadence

    // P3b: call === idea (self-linked), so `status` is the ONE converged field. Promotion
    // (awaiting-fill → in-position) is detected by the stamped fill_at, not a status name.
    if (idea.status === 'closed') return _closeFromIdea(call, idea, nowMs, bumpCount, trade)

    const inPos = idea.status === 'long' || idea.status === 'short'
    if (inPos) {
        const promoted = call.position_state?.entry?.fill_at != null
        if (!promoted) return _promoteToInPosition(call, idea, nowMs, nextAt, bumpCount, trade)
        return { manage: true }   // already in position → the management brain
    }
    return idle   // 'hit' / awaiting fill
}

// confirmed → in_position: stamp the fill onto the pre-seeded position_state and open the journal
// for the management era. fill_price is best-effort in slice 1 (the intended entry); broker-
// authoritative sourcing (findOpenPosition / trades ledger) is a later slice. Pure.
function _promoteToInPosition(call, idea, nowMs, nextAt, bumpCount, trade = null) {
    const ps        = call.position_state ?? {}
    const dir       = idea.direction ?? (idea.status === 'short' ? 'short' : 'long')
    // Real broker fill from the trades ledger; fall back to the intended entry until it's captured.
    const fillPrice = toNum(trade?.entry?.price) ?? ps.entry?.intended ?? null
    const fillAtMs  = idea.entryTriggeredAt ?? idea.activatedAt ?? nowMs
    const set = {
        // P3b: no status write — the converged status stays 'long'/'short' (set by the reconciler).
        // Promotion is recorded by position_state.entry.fill_at below (the _reconcilePosition gate).
        'position_state.entry.fill_price': fillPrice,
        'position_state.entry.fill_at':    new Date(fillAtMs).toISOString(),
        'position_state.entry.size':       idea.quantity ?? ps.entry?.size ?? null,
        'position_state.entry.direction':  dir,
        'position_state.phase':            'running',
        'monitor_state.next_check_at':     nextAt,
        'monitor_state.check_count':       bumpCount,
    }
    const note = `Filled ${call.asset}${fillPrice != null ? ` at ${fillPrice}` : ''} — I'm in. Initial stop ${ps.stop?.initial ?? '?'}; managing from here.`
    const entry = { at: new Date(nowMs).toISOString(), reason: 'entry', phase: 'in_position', price: toNum(fillPrice), verdict: null, note, next_check_at: nextAt }
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
    const entryPx = ps.entry?.fill_price ?? toNum(trade?.entry?.price) ?? ps.entry?.intended ?? null
    const exitPx  = toNum(trade?.exit?.price)
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
        at, reason: 'in_position', phase: 'in_position', price: toNum(price), verdict,
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
    if (!raw || raw._failReason) {
        // Assessment failed — retry soon (min gap), keep metrics fresh.
        const nextAt = new Date(nowMs + _minGapMs(call.cadence)).toISOString()
        await _persist(db, call.id, {
            ..._metricsSet(metrics),
            'monitor_state.next_check_at': nextAt,
            'monitor_state.check_count':   (call?.monitor_state?.check_count ?? 0) + 1,
        }, { at: new Date(nowMs).toISOString(), reason: 'in_position', phase: 'in_position', price: toNum(price), verdict: null,
             note: failNote('reassess', call.asset, raw?._failReason), next_check_at: nextAt })
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
export const _isPreActive = isPreActive

// Within EXPIRY_THRESHOLD of valid_until (or already past) → time for the final expiry review.
export const _isExpiring = (call, nowMs, thresholdMs = EXPIRY_THRESHOLD_MS) => isExpiring(call, nowMs, thresholdMs)

// Clamp the agent's requested gap (minutes) to the call's cadence, return an ISO next_check_at.
export function _computeNextCheckAt(nowMs, requestedMin, cadence) {
    const min = Number(cadence?.min_gap_min) || 1
    const max = Number(cadence?.max_gap_min) || 60
    // fallback = the LAZY end: don't burn quota re-reading a quiet name the model said nothing about.
    // A setup falls back the other way. See clampGap.
    return new Date(nowMs + clampGap(requestedMin, { min, max, fallback: max }) * 60_000).toISOString()
}

/**
 * Status transition from the verdict. Only ENTRY moves the lifecycle.
 *
 * `edit` and `let_expire` are about the THESIS going stale, not about entry, so they no longer
 * mint statuses of their own — `edit` latches the invalidation axis (see _invalidationPatch) and
 * `let_expire` closes with a reason. That is what ideas have always done, and it is why a call's
 * language used to diverge from every other kind's.
 */
export const _nextStatus = nextStatus

/**
 * The thesis went stale before entry → latch the invalidation axis and leave the lifecycle alone.
 * Fire-once: the monitor stops re-firing until the user re-maps (editCall clears it) or lets it go.
 */
export function _invalidationPatch(reason = null) {
    return {
        invalidation_status: INVALIDATION.FIRED,
        invalidation_edge:   'time',
        invalidation_reason: reason,
    }
}

// Actually past valid_until (not merely within the pre-expiry review window, which _isExpiring covers).
export const _isPastExpiry = isPastExpiry

// Reconcile the model's verdict against WHY we assessed + the clock, so two off-menu cases can't
// misbehave:
//   • let_expire on a zone trip would terminally kill a call still inside its validity window —
//     let_expire is only on the menu for an expiry review, so downgrade it to stand_aside.
//   • an expiry review that's actually PAST valid_until but still won't commit (wait/stand_aside)
//     would re-queue to 'waiting' and be re-assessed (chart + vision LLM) every cadence forever —
//     force it to let_expire so the call terminates. Within the pre-expiry window (not yet past),
//     wait/stand_aside stay legitimate. Pure.
// A call ALSO spares `edit` from the past-expiry cutoff: an edit latches the invalidation axis
// (_invalidationPatch, fire-once), so a stale-map verdict cannot re-fire and re-open the loop the
// cutoff closes. Talos spares only `enter` — see the note there.
const SPARE_PAST_EXPIRY = ['enter', 'edit']
export const _effectiveVerdict = (verdict, reason, pastExpiry) =>
    effectiveVerdict(verdict, reason, pastExpiry, SPARE_PAST_EXPIRY)

// The five verdicts the readiness read may return. An off-menu value (a model typo / hallucination)
// must not silently route as a wait with no trace — _applyAssessment coerces it to 'wait' and
// _checkCall logs it. Mirrors the hard whitelist the in-position path already applies.
const _READINESS_VERDICTS = new Set(['enter', 'wait', 'stand_aside', 'let_expire', 'edit'])

// Shared with Talos — see readinessGates.hasEditProposal. Re-exported under the historical name so
// the existing tests and call sites are unchanged.
export const _hasEditProposal = hasEditProposal

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
    // Output-shape guardrails on the model's raw verdict (parity with the position path's whitelist):
    //   • an off-menu verdict (typo/hallucination) → safe 'wait' (never mis-route or drop an entry card)
    //   • an 'edit' with no usable edit_proposal → 'wait' (don't fire a blank re-map card)
    let rawVerdict = _READINESS_VERDICTS.has(raw?.verdict) ? raw.verdict : 'wait'
    if (rawVerdict === 'edit' && !_hasEditProposal(raw)) rawVerdict = 'wait'

    // Resolve the effective verdict next (guards the two clock/context cases in _effectiveVerdict),
    // then derive proposal / status / card from it — never from the raw model verdict.
    const verdict  = _effectiveVerdict(rawVerdict, reason, _isPastExpiry(call, nowMs))
    const nextAt   = _computeNextCheckAt(nowMs, raw.next_check_min, call?.cadence)
    const proposal = verdict === 'enter' ? _finalizeProposal(raw.proposal, call, zone) : null
    const status   = _nextStatus(verdict)
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
        // The thesis going stale is the INVALIDATION axis, not the lifecycle. `edit` latches it
        // (fire-once, so the re-map card cannot spam); `let_expire` is terminal with a reason.
        ...(verdict === 'edit' ? _invalidationPatch(raw.edit_proposal?.why ?? raw.read ?? null) : {}),
        ...(verdict === 'let_expire'
            ? { status: 'closed', closedReason: 'expired', closedAt: nowMs }
            : {}),
        'monitor_state.armed_zone_id':    zone?.id ?? call?.monitor_state?.armed_zone_id ?? null,
        'monitor_state.chosen_timeframe': raw.timeframe_used ?? null,
        'monitor_state.check_count':      (call?.monitor_state?.check_count ?? 0) + 1,
        'monitor_state.memo':             memo,
        'monitor_state.next_check_at':    nextAt,
        'monitor_state.last_assessment':  lastAssessment,
    }

    // enter → ready card; edit → re-map card; let_expire → expired card. Never silent.
    return { set, fireCard: ['enter', 'edit', 'let_expire'].includes(verdict), lastAssessment }
}

// Cheap-path reschedule (no assessment ran). Idle → check further out (max gap); after a failed
// assessment → retry soon (min gap). Bumps the check counter. Pure $set patch.
export function _scheduledPatch(call, nowMs, short = false, price = null) {
    const cadence = call?.cadence ?? {}
    const lo = Number(cadence.min_gap_min) || 1
    const hi = Number(cadence.max_gap_min) || 60
    // `short` (assessment-failure retry) always uses the min cadence. Otherwise the gap is
    // proximity-aware: tighten toward min as price nears a mapped zone so a fast approach/breakout
    // isn't sampled over by the slow far-from-zone cadence (a narrow above-price breakout band can be
    // jumped between 60-min polls). No live price (pre-active / market-closed / feed miss) → max cadence.
    const gap = short ? lo : _proximityGapMin(call, price, lo, hi)
    return {
        // No zone tripped (or market closed) → the call isn't actively being assessed, so a stale

        'monitor_state.check_count':   (call?.monitor_state?.check_count ?? 0) + 1,
        'monitor_state.next_check_at': new Date(nowMs + gap * 60_000).toISOString(),
    }
}

// Graded scheduled cadence: how soon to re-check based on how close price is to the NEAREST mapped
// zone, measured in multiples of that zone's own band width. The band is ATR-sized by the build agent,
// so its width already encodes the instrument's volatility — this scales with volatility WITHOUT an
// extra ATR fetch on the cheap (LLM-free) scheduled path. Within NEAR_BANDS of an edge → min cadence
// (catch a fast approach/break); beyond FAR_BANDS → max cadence; linear in between. Non-finite price,
// no zones, or no usable band → max cadence (nothing to close in on). Pure.
const NEAR_BANDS = 2    // ≤ 2 band-widths from an edge → poll at the min cadence
const FAR_BANDS  = 10   // ≥ 10 band-widths away → poll at the max cadence
export function _proximityGapMin(call, price, minGap, maxGap) {
    return gradedGap(_nearestZoneDistance(call, price), { min: minGap, max: maxGap, near: NEAR_BANDS, far: FAR_BANDS })
}

/**
 * Distance to the nearest mapped zone, in multiples of THAT zone's own band width.
 *
 * A call's measurement, not a shared one: a band with `hi <= lo` is SKIPPED here, so a call whose
 * only zone is zero-width reports no usable distance and falls to the lazy cadence. Talos measures
 * to such a zone instead, because a zero-width setup zone is an exact level the user named and is
 * legal by its schema. Both behaviours are test-locked; the extraction shares the interpolation
 * between the bands, not the question of what counts as a band. Pure.
 */
export function _nearestZoneDistance(call, price) {
    if (!Number.isFinite(price)) return null
    let best = Infinity
    for (const z of (Array.isArray(call?.entry_zones) ? call.entry_zones : [])) {
        const lo = Number(z?.lower), hi = Number(z?.upper)
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) continue
        const dist = price < lo ? (lo - price) : price > hi ? (price - hi) : 0
        best = Math.min(best, dist / (hi - lo))
    }
    return Number.isFinite(best) ? best : null
}

// ─── Out-of-zone momentum pulse (Tier 2) ───────────────────────────────────────
// Between builds, price can develop a setup at a level Kairos never mapped. The cheap arithmetic gate
// would never wake the LLM there. `_shouldPulse` is the middle gate: on a scheduled (out-of-zone) wake,
// a MATERIAL, THROTTLED move away from every zone earns ONE full visual read that can re-map the call.
// Material = ≥ PULSE_MOVE_BANDS × the nearest zone's band width from the last "eyes-on" anchor (the band
// is ATR-sized → a free volatility yardstick). Throttled by the anchor reset (each pulse re-anchors, so
// it needs a fresh full increment to fire again) plus a time floor, so a trending name that keeps making
// new highs doesn't fire a read on every bar.
const PULSE_MOVE_BANDS  = 4     // material move = 4× the nearest band width from the anchor
const PULSE_MIN_GAP_MIN = 20    // never pulse more than ~once / 20 min / call

// Band width of the zone whose band price is NEAREST to (null if no usable band). Pure.
export function _nearestZoneWidth(call, price) {
    const zones = Array.isArray(call?.entry_zones) ? call.entry_zones : []
    let width = null, bestDist = Infinity
    for (const z of zones) {
        const lo = Number(z?.lower), hi = Number(z?.upper)
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) continue
        const dist = price < lo ? (lo - price) : price > hi ? (price - hi) : 0
        if (dist < bestDist) { bestDist = dist; width = hi - lo }
    }
    return width
}

// Should this scheduled (out-of-zone) wake escalate to a full visual pulse read? Pure — all inputs
// come from the call + live price + clock. Guards, cheapest-first: finite price; resting pre-entry
// ('waiting', so no enter/edit card is pending); NOT in a zone (that's Tier 1); anchor seeded; a real
// volatility yardstick; a material move from the anchor; and the time throttle.
export function _shouldPulse(call, price, nowMs) {
    if (!Number.isFinite(price)) return false
    if (call?.status !== 'waiting') return false
    if (_zoneGate(call, price)) return false
    const ms     = call?.monitor_state ?? {}
    const anchor = Number(ms.pulse_anchor_px)
    if (!Number.isFinite(anchor)) return false
    const w = _nearestZoneWidth(call, price)
    if (!Number.isFinite(w) || w <= 0) return false
    if (Math.abs(price - anchor) < PULSE_MOVE_BANDS * w) return false
    const lastAt = Date.parse(ms.last_pulse_at ?? '')
    if (Number.isFinite(lastAt) && (nowMs - lastAt) < PULSE_MIN_GAP_MIN * 60_000) return false
    return true
}

// ─── Timeline / monologue (the monitor journal) ────────────────────────────────
// The shape, the cap mechanics and the cheap-wake prose now live in monitorJournal.js — Talos kept
// a sentence-less copy of all of it, so setups had a journal nothing could read. What stays here is
// Hermes's own: how long its log runs, what a read PULLED, and the four-axis payload of an
// assessment. Re-exported under their historical names so the unit tests' import path is unchanged.
//

export { zonesLabel as _zonesLabel, failNote as _failNote }

// What the assessment deterministically pulls (mirrors _defaultAssess) — the "fetched" line.
function _fetchedLabel(call) {
    const tf = call?.timeframe_ladder?.at(-1) ?? '15min'
    return `chart ${tf} (vwap+ema50+vol) · ~30 candles · price`
}

// One journal entry for a wake — the shared builder, plus the part that is Hermes's alone: the
// four-axis payload of an assessment. `call` rather than `entity` in the signature because every
// call site here (and the tests) speaks calls; the shared builder is kind-agnostic.
// reason ∈ pre_active | closed | scheduled | momentum_pulse | zone_trip | expiry_review.
export function _timelineEntry(reason, { call, raw = null, ...rest }) {
    return journalEntry(reason, {
        ...rest,
        entity: call,
        raw,
        // Built here, not in the shared service: only Hermes assesses on four axes. The cheap and
        // failed branches return before this is looked at.
        axes: raw ? {
            market:        raw.market ?? null,
            news:          raw.news ?? null,
            price_action:  raw.price_action ?? null,
            patterns_seen: Array.isArray(raw.patterns_seen) ? raw.patterns_seen : [],
        } : null,
    })
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
    getIdea:     async (id) => { if (!id) return null; try { return await (await getDb()).collection(ENTITIES).findOne({ id }) } catch { return null } },
    // The ledger trade for the idea's main position (real entry/exit price + realized P&L) — the
    // broker-authoritative source for the close outcome (slice 4). Null when not yet captured.
    getTrade:    async (idea) => {
        const slot = (idea?.brokerOrders ?? []).find(b => b?.positionId != null)
        if (!slot) return null
        try { return await (await getDb()).collection(TRADES).findOne({ accountId: String(slot.accountId), positionId: String(slot.positionId) }) } catch { return null }
    },
    // The in-position four-axis management read (slice 2) and the management-card delivery. onManage
    // logs for now — real notify + user-confirm execution is slice 3 (mirrors Phase 2→3 for onCard).
    assessPosition: _defaultAssessPosition,
    onManageCard:   _defaultOnManageCard,
    // The one-shot re-entry thesis check at a stop-out + its card delivery (P2).
    assessReentry:  _defaultAssessReentry,
    onReentry:      _defaultOnReentry,
}

// Quote-then-candles last price. Body moved to monitorUtils.fetchLastPrice so Talos's zone gate
// reads prices through the SAME fallback chain (a divergence here means one monitor silently
// never fires). Behaviour is unchanged.
async function _defaultGetPrice(call) {
    return fetchLastPrice(call.asset)
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

// ─── In-position management card ───────────────────────────────────────────────
// Post the management card to social chat (routes to the call pop-out, where the user accepts or
// dismisses → the manageCall handoff executes it). Best-effort: a notify failure must never wedge
// the monitor loop.
async function _defaultOnManageCard(call, card) {
    logger.info(LOG, 'MANAGEMENT CARD', { id: call.id, asset: call.asset, verdict: card?.verdict, proposal: card?.proposal })
    try { await notifyCallManage(call, card) }
    catch (err) { logger.warn(LOG, `onManageCard notify failed for ${call.id}:`, err.message) }
}

// ─── Re-entry card (P2) ─────────────────────────────────────────────────────────
// Post the stop-out re-entry offer to social chat (Kairos-voiced; routes to the call pop-out, where
// the user picks Re-enter → reviveCall / Close → leave terminal). Best-effort: a notify failure must
// never wedge the monitor loop.
async function _defaultOnReentry(call, read, outcome) {
    logger.info(LOG, 'REENTRY CARD', { id: call.id, asset: call.asset, thesis_alive: read?.thesis_alive })
    try { await notifyCallReentry(call, read, outcome) }
    catch (err) { logger.warn(LOG, `onReentry notify failed for ${call.id}:`, err.message) }
}

