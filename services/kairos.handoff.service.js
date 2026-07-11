import { getDb } from '../providers/mongodb.provider.js'
import { ideaService } from '../api/trade-ideas/tradeIdeas.service.js'
import { placeOrdersForIdea } from '../api/trade-ideas/ideaExecution.service.js'
import { notifyManualEntry, entryLegFromIdea } from './manualNotify.service.js'
import { notifyCallManage } from './tradeNotify.service.js'
import { brokerService } from '../api/broker/broker.service.js'
import { normalizeZones, normalizeReferenceLevels } from '../api/kairos/kairos.service.js'
import { logger } from './logger.service.js'

// Kairos Phase 3 — the confirm / edit / dismiss handoff. When the user acts on a readiness card,
// this materializes the call as a REAL idea (via saveIdea, immediate market entry) and places it,
// handing the position off to the existing idea infrastructure. The Kairos call is then done
// (status 'confirmed'). Mode (live/paper/manual) is DERIVED from the call's broker.

const LOG        = '[kairos.handoff]'
const COLLECTION = 'kairos_calls'

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────────
export function deriveMode(broker) {
    if (broker === 'ctrader') return 'live'
    if (broker === 'paper')   return 'paper'
    if (broker === 'manual')  return 'manual'
    return null
}

// Map a confirmed call + its fired proposal to a saveIdea() input: an IMMEDIATE market entry with
// the stop + FINAL target as native `touch` exits. saveIdea builds the condition trees, resolves
// the broker symbol, and re-measures basisOffset — so the placed idea lives in the normal system.
//
// Exits MUST be `touch` leaves (not bare stop_loss/take_profit strings — those resolve to NO tree,
// nor `structured`, which routes to the software monitor): the linked idea is flagged
// ownedBy:'hermes' and skipped by Minos, so only a broker-native order (a touch) actually protects
// the position. The hard native bracket is stop + the FINAL target; intermediate targets are
// discretionary Hermes scale-outs (position_state.targets), not placed as idea exits.
export function buildIdeaFromCall(call, proposal, direction) {
    // Direction is the ARMED zone's side (a 'both'-bias call can fire either way); fall back to bias.
    const dir = direction ?? (call?.bias === 'short' ? 'short' : 'long')
    const tps = Array.isArray(proposal?.take_profit) ? proposal.take_profit : []
    const finalTp = tps.length ? tps[tps.length - 1]?.price : null
    return {
        asset:         call?.asset,
        asset_class:   call?.asset_class ?? null,
        direction:     dir,
        quantity:      proposal?.size ?? null,
        immediate:     true,                                     // market entry now
        stop_conditions: proposal?.stop != null ? [_touch(proposal.stop)] : undefined,
        tp_conditions:   finalTp != null        ? [_touch(finalTp)]       : undefined,
        accounts:      Array.isArray(call?.accounts) ? call.accounts : [],
        mainAccountId: call?.main_account_id ?? null,
        notes:         `Kairos call ${call?.id}${proposal?.rationale ? ` — ${proposal.rationale}` : ''}`,
    }
}

// A single native price-touch leaf (rests at the broker as a closing STOP/LIMIT). Pure.
function _touch(level) {
    return { condition: `price touches ${level}`, type: 'touch', timeframe: null }
}

// The in-position scaffold (Phase 5), initialized at confirm. `entry.fill_price` is filled when
// Hermes promotes confirmed→in_position on the real fill; here we stamp the intended entry, the
// initial stop (the R denominator), and the target ladder. Pure.
export function buildPositionState(call, proposal, direction, ideaId) {
    const dir = direction ?? (call?.bias === 'short' ? 'short' : 'long')
    const tps = Array.isArray(proposal?.take_profit) ? proposal.take_profit : []
    const targets = tps.map((t, i) => ({
        id: `tg${i + 1}`, price: t?.price ?? null, ref: t?.ref ?? null, size_pct: null, hit_at: null,
    }))
    return {
        linked_idea_id: ideaId ?? null,
        entry:   { fill_price: null, intended: proposal?.entry ?? null, fill_at: null, size: proposal?.size ?? null, direction: dir, account_id: call?.main_account_id ?? null },
        stop:    { current: proposal?.stop ?? null, initial: proposal?.stop ?? null, ref: proposal?.stop_ref ?? null },
        targets,
        taken:   [],
        metrics: { r_multiple_now: null, mae: null, mfe: null, bars_held: 0 },
        phase:   'running',
        memo:    '',
        pending_action:  null,
        last_management: null,
        outcome: null,
    }
}

// Turn an accepted edit_proposal into a $set that re-maps the call and re-queues it. Re-mapped
// zones/levels are normalized the same way the build path does, so the arithmetic gate stays valid.
export function applyEditPatch(editProposal, bias = null) {
    const changes = editProposal?.changes ?? {}
    const set = {
        status: 'waiting',
        'monitor_state.armed_zone_id':   null,
        'monitor_state.next_check_at':   null,   // due on the next tick
        'monitor_state.last_assessment': null,
    }
    if (changes.valid_until) set.valid_until = changes.valid_until
    if (Array.isArray(changes.entry_zones))      set.entry_zones      = normalizeZones(changes.entry_zones, bias)
    if (Array.isArray(changes.reference_levels)) set.reference_levels = normalizeReferenceLevels(changes.reference_levels)
    return set
}

// ── Orchestration (injectable deps for testing) ────────────────────────────────
const _deps = {
    getDb,
    saveIdea:           (input, userId)               => ideaService.saveIdea(input, userId),
    placeOrdersForIdea: (id, orders, userId, isAdmin) => placeOrdersForIdea(id, orders, userId, isAdmin),
    notifyManualEntry:  (userId, opts)                => notifyManualEntry(userId, opts),
    entryLegFromIdea,
    // Flag the linked idea Hermes-owned so Minos + checkInvalidation stand down (Phase 5): Hermes
    // is the sole in-position brain; the event-driven reconciler stays the shared hands.
    markIdeaOwned:      async (ideaId) => { const db = await getDb(); await db.collection('ideas').updateOne({ id: ideaId }, { $set: { ownedBy: 'hermes' } }) },
}

async function _loadOwned(db, id, userId, isAdmin, projection = {}) {
    const call = await db.collection(COLLECTION).findOne({ id }, Object.keys(projection).length ? { projection } : undefined)
    if (!call) return { err: 'not_found' }
    if (call.user_id && call.user_id !== userId && !isAdmin) return { err: 'forbidden' }
    return { call }
}

// Confirm an enter-ready call: materialize the idea, place per mode, mark the call confirmed.
export async function confirmCall(id, userId, isAdmin = false, deps = _deps) {
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId, isAdmin)
    if (err) return { ok: false, reason: err }
    if (call.status !== 'ready') return { ok: false, reason: 'not_ready' }

    const proposal = call.monitor_state?.last_assessment?.proposal
    if (!proposal) return { ok: false, reason: 'no_proposal' }

    const mode = deriveMode(call.broker)
    if (!mode) return { ok: false, reason: 'no_venue' }

    const armedZone = (call.entry_zones ?? []).find(z => z.id === call.monitor_state?.armed_zone_id)
    const direction = armedZone?.side
    const saved = await deps.saveIdea(buildIdeaFromCall(call, proposal, direction), userId)
    if (!saved?.ok) return { ok: false, reason: saved?.reason ?? 'idea_create_failed' }
    const idea = saved.idea

    // Hermes owns this position end-to-end — stamp the idea BEFORE placement so Minos can't pick it
    // up in the window between save and fill (its own tick could otherwise race the fill).
    await deps.markIdeaOwned(idea.id)

    try {
        if (mode === 'manual') {
            // Broker-less: post the fill card; the user reports the real fill at their broker.
            await deps.notifyManualEntry(userId, { legs: [deps.entryLegFromIdea(idea)] })
        } else {
            // paper / live: place the market entry (+ native stop/TP exits) via the idea engine.
            await deps.placeOrdersForIdea(idea.id, idea.pendingOrder?.plan ?? [], userId, isAdmin)
        }
    } catch (placeErr) {
        logger.error(LOG, `handoff placement failed for ${id}:`, placeErr.message)
        return { ok: false, reason: 'placement_failed', ideaId: idea.id }
    }

    // status 'confirmed' = order placed / awaiting fill. Hermes's tick watches the linked idea and
    // promotes the call to 'in_position' when it actually opens (Phase 5). Seed position_state now.
    await db.collection(COLLECTION).updateOne(
        { id },
        { $set: {
            status:         'confirmed',
            linked_idea_id: idea.id,
            confirmed_at:   new Date().toISOString(),
            position_state: buildPositionState(call, proposal, direction, idea.id),
            // Reset the readiness-phase cadence so the position path checks for the fill on the next
            // tick (else it could inherit a next_check_at up to max_gap in the future).
            'monitor_state.next_check_at': null,
        } },
    )
    logger.info(LOG, `call ${id} confirmed → idea ${idea.id} (${mode})`)
    return { ok: true, mode, ideaId: idea.id }
}

// Accept the expiry edit: re-map + re-queue the call to 'waiting'.
export async function editCall(id, userId, isAdmin = false, deps = _deps) {
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId, isAdmin)
    if (err) return { ok: false, reason: err }
    if (call.status !== 'expiring') return { ok: false, reason: 'not_editable' }

    const editProposal = call.monitor_state?.last_assessment?.edit_proposal
    if (!editProposal) return { ok: false, reason: 'no_edit_proposal' }

    await db.collection(COLLECTION).updateOne({ id }, { $set: applyEditPatch(editProposal, call.bias) })
    logger.info(LOG, `call ${id} edited → re-queued`)
    return { ok: true }
}

// Dismiss any surfaced card. Context-aware: an in-position management card only clears the pending
// suggestion (the live position keeps running); any other card is the terminal readiness dismiss.
export async function dismissCall(id, userId, isAdmin = false, deps = _deps) {
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId, isAdmin, { user_id: 1, status: 1 })
    if (err) return { ok: false, reason: err }
    if (call.status === 'in_position') {
        await db.collection(COLLECTION).updateOne({ id }, { $set: { 'position_state.pending_action': null } })
        logger.info(LOG, `call ${id} management card dismissed (position kept)`)
        return { ok: true, dismissed: 'card' }
    }
    await db.collection(COLLECTION).updateOne({ id }, { $set: { status: 'dismissed' } })
    logger.info(LOG, `call ${id} dismissed`)
    return { ok: true }
}

// ── In-position management (Phase 5, slice 3 — the hands) ──────────────────────
// The user accepts a management card (or dismisses it). Accept EXECUTES the pending proposal against
// the linked idea's broker position via the shared primitives (amend stop/TP, partial/full close);
// the execution reconciler then captures fills / resizes exits / finalizes closes off the resulting
// events. exit_now may also be user-initiated without a pending card. Broker-authoritative
// idempotency: if the position is already flat, just clear the card (Hermes reconciles the close).

const MANAGE_VERBS = new Set(['move_stop', 'take_partial', 'exit_now', 'let_run'])

const _mdeps = {
    getDb,
    getIdea:          async (id)                              => { if (!id) return null; const db = await getDb(); return db.collection('ideas').findOne({ id }) },
    findOpenPosition: (broker, userId, acct, positionId)      => brokerService.findOpenPosition(broker, userId, acct, positionId),
    closePosition:    (broker, userId, acct, positionId, opts)=> brokerService.closePosition(broker, userId, acct, positionId, opts),
    amendOrder:       (broker, userId, acct, orderId, fields) => brokerService.amendOrder(broker, userId, acct, orderId, fields),
    cancelOrder:      (broker, userId, acct, orderId)         => brokerService.cancelOrder(broker, userId, acct, orderId),
    notifyManage:     (call, card)                            => notifyCallManage(call, card),
    // Keep the idea's tracked native exit in step with a broker amend/cancel so the reconciler's
    // resize (on a later partial) doesn't cancel-and-replace it at the STALE price/id.
    syncIdeaExit:     async (ideaId, accountId, leg, patch)   => {
        const set = {}
        if (patch?.price   != null) set['exitOrders.$[e].price']   = patch.price
        if (patch?.orderId != null) set['exitOrders.$[e].orderId'] = String(patch.orderId)
        if (patch?.status  != null) set['exitOrders.$[e].status']  = patch.status
        if (!Object.keys(set).length) return
        const db = await getDb()
        await db.collection('ideas').updateOne({ id: ideaId }, { $set: set },
            { arrayFilters: [{ 'e.accountId': String(accountId), 'e.leg': leg, 'e.status': 'working' }] })
    },
}

// The main account's open-position linkage on the idea (broker/account/positionId/entry qty). Pure.
export function _resolveMainLink(idea, call) {
    const acct  = call?.main_account_id ?? null
    const links = Array.isArray(idea?.brokerOrders) ? idea.brokerOrders : []
    const slot  = links.find(b => b?.positionId != null && (acct == null || String(b.accountId) === String(acct)))
        ?? links.find(b => b?.positionId != null)
    if (!slot) return null
    return { broker: slot.broker, accountId: slot.accountId, positionId: slot.positionId, quantity: Number(slot.quantity) || 0 }
}

// The still-working native exit order for a leg on an account (the one to amend/cancel). Pure.
export function _workingExit(idea, accountId, leg) {
    return (idea?.exitOrders ?? []).find(o =>
        o?.leg === leg && o?.status === 'working' && o?.orderId != null && String(o.accountId) === String(accountId)) ?? null
}

// Idea-unit quantity for a percentage partial, capped at what's live. Pure.
export function _partialQty(remaining, sizePct) {
    const rem = Number(remaining)
    const pct = Number(sizePct)
    if (!(rem > 0) || !(pct > 0)) return 0
    return Math.min(rem, Math.round(rem * Math.min(100, pct) / 100 * 10000) / 10000)
}

function _phaseAfterStop(newStop, entry, isLong) {
    if (!Number.isFinite(newStop) || !Number.isFinite(entry)) return 'trailing'
    const atBreakeven = isLong ? newStop >= entry : newStop <= entry
    return atBreakeven ? 'breakeven' : 'trailing'
}

// The persisted change after an executed action: $set (stop/phase, clear pending) + $push
// (taken ledger for a partial, always the journal). `extra.qty` is the executed partial size. Pure.
export function _manageAppliedUpdate(verb, proposal, ps, extra, nowMs) {
    const at    = new Date(nowMs).toISOString()
    const isLong = (ps?.entry?.direction ?? 'long') !== 'short'
    const entry  = ps?.entry?.fill_price ?? ps?.entry?.intended ?? null
    const set  = { 'position_state.pending_action': null }
    const push = {}

    let note
    if (verb === 'move_stop') {
        set['position_state.stop.current'] = proposal?.new_stop ?? ps?.stop?.current ?? null
        set['position_state.stop.ref']     = proposal?.ref ?? null
        set['position_state.phase']        = _phaseAfterStop(proposal?.new_stop, entry, isLong)
        note = `Moved my stop to ${proposal?.new_stop} — ${set['position_state.phase'] === 'breakeven' ? 'locking in breakeven' : 'tightening protection'}.`
    } else if (verb === 'let_run') {
        set['position_state.phase'] = 'runner'
        note = proposal?.cancel_tp ? 'Cancelled the take-profit — letting this run.' : `Raised the take-profit to ${proposal?.new_tp} — letting it run.`
    } else if (verb === 'take_partial') {
        push['position_state.taken'] = { at, size: extra?.qty ?? null, price: null, r_multiple: null, kind: 'partial' }
        note = `Banked ${proposal?.size_pct}% here — taking money off the table.`
    } else if (verb === 'exit_now') {
        note = 'Flattening the rest now — the trade is done for me.'
    }

    push['monitor_state.timeline'] = { $each: [{ at, reason: 'in_position', phase: 'in_position', price: null, verdict: verb, note, next_check_at: null }], $slice: -80 }
    return { $set: set, $push: push }
}

// Execute the resolved proposal against the broker. Returns { qty } (executed partial size) for the
// applied-update. Throws on a broker failure (caller maps to execution_failed).
async function _executeManage(verb, proposal, idea, link, open, userId, isAdmin, deps) {
    const { broker, accountId, positionId } = link
    if (verb === 'move_stop' || verb === 'let_run') {
        const leg = verb === 'move_stop' ? 'stop' : 'tp'
        const ord = _workingExit(idea, accountId, leg)
        if (!ord) throw new Error(`no working ${leg} order to amend`)
        if (verb === 'let_run' && proposal?.cancel_tp) {
            await deps.cancelOrder(broker, userId, accountId, ord.orderId)
            await deps.syncIdeaExit(idea.id, accountId, leg, { status: 'cancelled' })
            return {}
        }
        const level  = verb === 'move_stop' ? Number(proposal.new_stop) : Number(proposal.new_tp)
        const fields = verb === 'move_stop' ? { stopPrice: level } : { limitPrice: level }
        const res    = await deps.amendOrder(broker, userId, accountId, ord.orderId, fields)
        await deps.syncIdeaExit(idea.id, accountId, leg, { price: level, orderId: res?.orderId ?? null })
        return {}
    }
    if (verb === 'take_partial') {
        const remaining = Number(open?.volume) || link.quantity
        const qty = _partialQty(remaining, proposal?.size_pct)
        if (!(qty > 0)) throw new Error('partial size resolved to 0')
        await deps.closePosition(broker, userId, accountId, positionId, { quantity: qty })
        return { qty }
    }
    // exit_now → full close
    await deps.closePosition(broker, userId, accountId, positionId)
    return {}
}

// Handle an in-position management action. verb ∈ MANAGE_VERBS. Accept executes the pending proposal
// (exit_now also works bare); dismiss clears the card.
export async function manageCall(id, userId, verb, isAdmin = false, deps = _mdeps) {
    if (!MANAGE_VERBS.has(verb)) return { ok: false, reason: 'bad_action' }
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId, isAdmin)
    if (err) return { ok: false, reason: err }
    if (call.status !== 'in_position') return { ok: false, reason: 'not_in_position' }

    const ps  = call.position_state ?? {}
    const now = Date.now()

    // Resolve the proposal from the pending card (verb must match) — or a bare user-initiated exit_now.
    const pending = ps.pending_action
    let proposal
    if (pending && pending.verdict === verb) proposal = pending.proposal
    else if (verb === 'exit_now')            proposal = {}
    else return { ok: false, reason: 'no_pending_action' }

    const idea = await deps.getIdea(call.linked_idea_id)
    if (!idea) return { ok: false, reason: 'idea_not_found' }

    // Manual (broker-less): notify the instruction + record intent; the user acts at their broker.
    if (deriveMode(call.broker) === 'manual') {
        await deps.notifyManage(call, { verdict: verb, proposal, manual: true })
        await db.collection(COLLECTION).updateOne({ id }, _manageAppliedUpdate(verb, proposal, ps, {}, now))
        return { ok: true, manual: true, verb }
    }

    const link = _resolveMainLink(idea, call)
    if (!link) return { ok: false, reason: 'no_position_link' }

    // Broker-authoritative idempotency: already flat → clear the card, let Hermes reconcile the close.
    let open
    try { open = await deps.findOpenPosition(link.broker, userId, link.accountId, link.positionId) }
    catch { return { ok: false, reason: 'broker_unreachable' } }
    if (open === null) {
        await db.collection(COLLECTION).updateOne({ id }, { $set: { 'position_state.pending_action': null } })
        return { ok: true, alreadyFlat: true }
    }

    let applied
    try { applied = await _executeManage(verb, proposal, idea, link, open, userId, isAdmin, deps) }
    catch (e) { logger.error(LOG, `manage ${verb} failed for ${id}:`, e.message); return { ok: false, reason: 'execution_failed' } }

    await db.collection(COLLECTION).updateOne({ id }, _manageAppliedUpdate(verb, proposal, ps, applied, now))
    logger.info(LOG, `call ${id} managed → ${verb}`)
    return { ok: true, verb }
}

export const kairosHandoffService = { confirmCall, editCall, dismissCall, manageCall }
