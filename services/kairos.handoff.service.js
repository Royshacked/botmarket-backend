import { getDb } from '../providers/mongodb.provider.js'
import { ENTITIES } from './entity/entityCollection.js'
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
const COLLECTION = ENTITIES   // calls live in entities as kind:'call' (all ops here are {id}-scoped)

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
        callId:        call?.id ?? null,                          // origin back-reference → survives onto the trade
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
    buildIdeaChildren:  (input, userId)               => ideaService.buildIdeaChildren(input, userId),
    placeOrdersForIdea: (id, orders, userId, isAdmin) => placeOrdersForIdea(id, orders, userId, isAdmin),
    notifyManualEntry:  (userId, opts)                => notifyManualEntry(userId, opts),
    entryLegFromIdea,
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

    // P3b — the call carries its OWN execution (no idea shadow). Enrich the entry via the shared idea
    // engine, then MERGE the single child's execution shape onto the CALL itself (keeping its id +
    // kind:'call'). Self-link (callId / linked_idea_id → this call) so the reconciler, Hermes, and
    // manageCall act on the call directly; keep ownedBy:'hermes' so Minos + checkInvalidation stand
    // down exactly as they did for the shadow. Status converges to the execution vocab (hit→long/short).
    const built = await deps.buildIdeaChildren(buildIdeaFromCall(call, proposal, direction), userId)
    if (!built.ok)                     return { ok: false, reason: built.reason ?? 'idea_create_failed' }
    if (built.children.length !== 1)   return { ok: false, reason: 'multi_broker_call' }
    const { id: _cid, kind: _ck, parentId: _cp, ...exec } = built.children[0]

    await db.collection(COLLECTION).updateOne(
        { id },
        { $set: {
            ...exec,                                       // status:'hit', condition trees, brokerSymbol,
                                                           // basisOffset, broker, direction, quantity, pendingOrder…
            callId:         id,                            // self-origin → tradeCapture origin.type='call'
            linked_idea_id: id,                            // self — getIdea(self) returns this call
            // No ownedBy flag: kind:'call' IS the ownership (Minos/getIdeas/getCallPositionMap are
            // kind-aware). ownerForKind('call')==='hermes'.
            confirmed_at:   new Date().toISOString(),
            position_state: buildPositionState(call, proposal, direction, id),
            'monitor_state.next_check_at': null,           // check for the fill on the next tick
        } },
    )

    // Re-read the merged call — it now carries the execution shape placement needs.
    const merged = await db.collection(COLLECTION).findOne({ id })

    try {
        if (mode === 'manual') {
            await deps.notifyManualEntry(userId, { legs: [deps.entryLegFromIdea(merged)] })
        } else {
            await deps.placeOrdersForIdea(id, merged.pendingOrder?.plan ?? [], userId, isAdmin)
        }
    } catch (placeErr) {
        logger.error(LOG, `handoff placement failed for ${id}:`, placeErr.message)
        // Roll the call back to 'ready' so it isn't stuck 'hit' with no orders — the user can retry
        // confirm. (The old flow left an orphaned shadow; here the call is the entity, so we reset it.)
        await db.collection(COLLECTION).updateOne({ id }, { $set: { status: 'ready' } })
        return { ok: false, reason: 'placement_failed', ideaId: id }
    }

    logger.info(LOG, `call ${id} confirmed → self-executing (${mode})`)
    return { ok: true, mode, ideaId: id }
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

// ── Re-entry after a stop-out (P2) ─────────────────────────────────────────────
// A fresh validity window for a revived call, keyed off its horizon so a just-revived call isn't
// immediately expired by the monitor. Pure (nowMs injectable for tests).
export function _reentryValidUntil(call, nowMs = Date.now()) {
    const days = call?.trade_type === 'swing' ? 14 : call?.trade_type === 'day' ? 3 : 1
    return new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString()
}

// [Re-enter] on a stop-out re-entry offer: revive the CLOSED call to a pre-entry armed state so the
// monitor watches the ORIGINAL plan again. The finished position is cleared (a new entry mints a fresh
// idea); the pulse anchor re-seeds; valid_until is extended so it isn't instantly expired. There is no
// coded re-entry budget — the human tap is the budget — but reentry_count is bumped for observability.
export async function reviveCall(id, userId, isAdmin = false, deps = _deps) {
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId, isAdmin)
    if (err) return { ok: false, reason: err }
    if (call.status !== 'closed')                        return { ok: false, reason: 'not_closed' }
    if (call.position_state?.reentry?.offered !== true)  return { ok: false, reason: 'no_reentry_offer' }

    const set = {
        status:         'waiting',
        valid_until:    _reentryValidUntil(call),
        linked_idea_id: null,
        position_state: null,
        confirmed_at:   null,
        'monitor_state.armed_zone_id':   null,
        'monitor_state.last_assessment': null,
        'monitor_state.next_check_at':   null,   // due on the next tick
        'monitor_state.pulse_anchor_px': null,   // re-seed the out-of-zone pulse anchor
        'monitor_state.last_pulse_at':   null,
    }
    await db.collection(COLLECTION).updateOne({ id }, { $set: set, $inc: { reentry_count: 1 } })
    const count = (call.reentry_count ?? 0) + 1
    logger.info(LOG, `call ${id} revived on re-entry → waiting (re-entry #${count})`)
    return { ok: true, reentry_count: count }
}

// [Close] on a re-entry offer: keep the call terminal-closed, just record the decline + clear the
// offer (so the card doesn't re-surface). NOT `dismiss` — that would flip status 'closed' → 'dismissed'
// and lose the trade outcome.
export async function declineReentry(id, userId, isAdmin = false, deps = _deps) {
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId, isAdmin, { user_id: 1, status: 1 })
    if (err) return { ok: false, reason: err }
    if (call.status !== 'closed') return { ok: false, reason: 'not_closed' }
    await db.collection(COLLECTION).updateOne({ id }, { $set: {
        'position_state.reentry.offered':     false,
        'position_state.reentry.declined_at': new Date().toISOString(),
    } })
    logger.info(LOG, `call ${id} re-entry declined`)
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
    getIdea:          async (id)                              => { if (!id) return null; const db = await getDb(); return db.collection(ENTITIES).findOne({ id }) },
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
        await db.collection(ENTITIES).updateOne({ id: ideaId }, { $set: set },
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

// EVERY account's open-position linkage — a call is placed one-position-per-account, so a management
// action fans out across ALL of them, not just the main. Pure. Scoped to the call's declared accounts
// when present; falls back to all open-position slots (so a live position is never left unmanaged).
export function _resolveAllLinks(idea, call) {
    const links  = (Array.isArray(idea?.brokerOrders) ? idea.brokerOrders : []).filter(b => b?.positionId != null)
    const accts  = Array.isArray(call?.accounts) ? call.accounts.map(String) : []
    const scoped = accts.length ? links.filter(b => accts.includes(String(b.accountId))) : links
    const chosen = scoped.length ? scoped : links   // never manage NONE while positions are open
    return chosen.map(slot => ({ broker: slot.broker, accountId: slot.accountId, positionId: slot.positionId, quantity: Number(slot.quantity) || 0 }))
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

    const links = _resolveAllLinks(idea, call)
    if (!links.length) return { ok: false, reason: 'no_position_link' }

    // Fan out across EVERY account the call is placed on (one position per account). Each is checked
    // broker-authoritatively (skip if already flat) and the action applied independently — a partial
    // failure on one account doesn't strand the others. The aggregate position_state (new stop level /
    // total partial qty summed across accounts) is written once, after all accounts have run.
    const perAccount = []
    let anyReachable = false, anyOpen = false, anyApplied = false, totalQty = 0
    for (const link of links) {
        let open
        try { open = await deps.findOpenPosition(link.broker, userId, link.accountId, link.positionId); anyReachable = true }
        catch { perAccount.push({ accountId: link.accountId, reason: 'broker_unreachable' }); continue }
        if (open === null) { perAccount.push({ accountId: link.accountId, alreadyFlat: true }); continue }
        anyOpen = true
        try {
            const applied = await _executeManage(verb, proposal, idea, link, open, userId, isAdmin, deps)
            anyApplied = true
            totalQty += Number(applied?.qty) || 0
            perAccount.push({ accountId: link.accountId, ok: true })
        } catch (e) {
            logger.error(LOG, `manage ${verb} failed for ${id} acct ${link.accountId}:`, e.message)
            perAccount.push({ accountId: link.accountId, reason: 'execution_failed' })
        }
    }

    if (!anyReachable) return { ok: false, reason: 'broker_unreachable', accounts: perAccount }
    if (!anyOpen) {   // every account already flat → clear the card, let Hermes reconcile the close(s)
        await db.collection(COLLECTION).updateOne({ id }, { $set: { 'position_state.pending_action': null } })
        return { ok: true, alreadyFlat: true }
    }
    if (!anyApplied) return { ok: false, reason: 'execution_failed', accounts: perAccount }   // every open account errored

    await db.collection(COLLECTION).updateOne({ id }, _manageAppliedUpdate(verb, proposal, ps, { qty: totalQty }, now))
    logger.info(LOG, `call ${id} managed → ${verb} across ${links.length} account(s)`)
    return { ok: true, verb, accounts: perAccount }
}

export const kairosHandoffService = { confirmCall, editCall, dismissCall, manageCall, reviveCall, declineReentry }
