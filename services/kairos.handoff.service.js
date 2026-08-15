import { getDb } from '../providers/mongodb.provider.js'
import { ENTITIES } from './entity/entityCollection.js'
import { ideaService } from '../api/trade-ideas/tradeIdeas.service.js'
import { placeOrdersForIdea } from '../api/trade-ideas/ideaExecution.service.js'
import { notifyManualEntry, entryLegFromIdea } from './manualNotify.service.js'
import { notifyCallManage } from './tradeNotify.service.js'
import { brokerService } from '../api/broker/broker.service.js'
import { normalizeZones, normalizeReferenceLevels } from '../api/kairos/kairos.service.js'
import { knownVenue } from './venue.resolve.service.js'
import { touchLeaf as _touch } from './protectionPlan.service.js'
import { ownsEntity } from './entity/entityCrud.service.js'
// The shared in-position executor (the hands). Imported as a namespace so the two dozen references
// below read as "the shared mechanism", not as a pile of loose helpers of unclear origin.
import * as _sharedManage from './positionManage.service.js'
import { isLivePosition, isAwaitingConfirm, isInvalidated } from './entity/vocabulary.js'
import { logger } from './logger.service.js'

// Kairos Phase 3 — the confirm / edit / dismiss handoff. When the user acts on a readiness card,
// this materializes the call as a REAL idea (via saveIdea, immediate market entry) and places it,
// handing the position off to the existing idea infrastructure. The Kairos call is then done
// (status 'confirmed'). Mode (live/paper/manual) is DERIVED from the call's broker.

const LOG        = '[kairos.handoff]'
const COLLECTION = ENTITIES   // calls live in entities as kind:'call' (all ops here are {id}-scoped)

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────────
// A VALIDITY gate, not a workspace label: null means "not a venue I can bind execution to".
// Distinct from venue.resolveMode, which always commits to a workspace. Delegates to the shared
// knownVenue so the supported-broker list has one home. Exported under its historical name.
export const deriveMode = knownVenue

// Map a confirmed call + its fired proposal to a saveIdea() input: an IMMEDIATE market entry with
// the stop + FINAL target as native `touch` exits. saveIdea builds the condition trees, resolves
// the broker symbol, and re-measures basisOffset — so the placed idea lives in the normal system.
//
// Exits MUST be `touch` leaves (not bare stop_loss/take_profit strings — those resolve to NO tree,
// nor `structured`, which routes to the software monitor): the confirmed call is kind:'call' and
// Minos skips it on that alone, so only a broker-native order (a touch) actually protects the
// position. The hard native bracket is stop + the FINAL target; intermediate targets are
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
    placeOrdersForIdea: (id, orders, userId) => placeOrdersForIdea(id, orders, userId),
    notifyManualEntry:  (userId, opts)                => notifyManualEntry(userId, opts),
    entryLegFromIdea,
}

// Reads through the INJECTED db (this module's whole test harness is a fake db), so it can't use
// the shared crud's own collection handle — but the ownership RULE is the shared one, so an
// ownerless legacy call is treated identically here and on the CRUD path.
async function _loadOwned(db, id, userId, projection = {}) {
    const call = await db.collection(COLLECTION).findOne({ id }, Object.keys(projection).length ? { projection } : undefined)
    if (!call) return { err: 'not_found' }
    if (!ownsEntity(call, userId)) return { err: 'forbidden' }
    return { call }
}

// Confirm an enter-ready call: materialize the idea, place per mode, mark the call confirmed.
export async function confirmCall(id, userId, deps = _deps) {
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId)
    if (err) return { ok: false, reason: err }
    if (!isAwaitingConfirm(call.status)) return { ok: false, reason: 'not_ready' }

    const proposal = call.monitor_state?.last_assessment?.proposal
    if (!proposal) return { ok: false, reason: 'no_proposal' }

    const mode = deriveMode(call.broker)
    if (!mode) return { ok: false, reason: 'no_venue' }

    const armedZone = (call.entry_zones ?? []).find(z => z.id === call.monitor_state?.armed_zone_id)
    const direction = armedZone?.side

    // P3b — the call carries its OWN execution (no idea shadow). Enrich the entry via the shared idea
    // engine, then MERGE the single child's execution shape onto the CALL itself (keeping its id +
    // kind:'call'). Self-link (callId / linked_idea_id → this call) so the reconciler, Hermes, and
    // manageCall act on the call directly. Minos + checkInvalidation stand down on kind:'call'
    // alone — no flag is written. Status converges to the execution vocab (hit→long/short).
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

    // A refusal here is a RESULT, not an exception: placeOrdersForIdea answers {ok:false, reason}
    // for every gate it owns (market_closed, no_orders, already_placed…) and only throws on an
    // unexpected fault. Catching alone therefore reported a confirmed, placed order for a call
    // where nothing had been sent — the user saw success and held no position. Both outcomes now
    // land in the same recovery, and the reason is passed through rather than flattened, so
    // "the market is shut" reads as itself instead of a generic placement failure.
    let failure = null
    try {
        if (mode === 'manual') {
            await deps.notifyManualEntry(userId, { legs: [deps.entryLegFromIdea(merged)], kind: 'call' })
        } else {
            const res = await deps.placeOrdersForIdea(id, merged.pendingOrder?.plan ?? [], userId)
            if (res && res.ok === false) failure = res.reason ?? 'placement_failed'
        }
    } catch (placeErr) {
        logger.error(LOG, `handoff placement failed for ${id}:`, placeErr.message)
        failure = 'placement_failed'
    }
    if (failure) {
        logger.warn(LOG, `handoff placement refused for ${id}: ${failure}`)
        // Leave it at 'hit' (plan built, awaiting confirm) so the user can retry — resetting it
        // would discard the plan. (The old flow left an orphaned shadow; here the call IS the entity.)
        await db.collection(COLLECTION).updateOne({ id }, { $set: { orderState: null } })
        return { ok: false, reason: failure, ideaId: id }
    }

    logger.info(LOG, `call ${id} confirmed → self-executing (${mode})`)
    return { ok: true, mode, ideaId: id }
}

// Accept the expiry edit: re-map + re-queue the call to 'waiting'.
export async function editCall(id, userId, deps = _deps) {
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId)
    if (err) return { ok: false, reason: err }
    // Gated on the INVALIDATION latch, not a lifecycle status: a stale thesis leaves the call
    // 'looking' and sets invalidation_status. Accepting the re-map clears the latch so the
    // fire-once watcher can fire again on the new plan.
    if (!isInvalidated(call.invalidation_status)) return { ok: false, reason: 'not_editable' }

    const editProposal = call.monitor_state?.last_assessment?.edit_proposal
    if (!editProposal) return { ok: false, reason: 'no_edit_proposal' }

    await db.collection(COLLECTION).updateOne({ id }, { $set: {
        ...applyEditPatch(editProposal, call.bias),
        invalidation_status: null, invalidation_edge: null, invalidation_reason: null,
    } })
    logger.info(LOG, `call ${id} edited → re-queued`)
    return { ok: true }
}

// Dismiss any surfaced card. Context-aware: an in-position management card only clears the pending
// suggestion (the live position keeps running); any other card is the terminal readiness dismiss.
export async function dismissCall(id, userId, deps = _deps) {
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId, { userId: 1, status: 1 })
    if (err) return { ok: false, reason: err }
    // A LIVE call: dismiss clears the management card only — the position keeps running. Gating
    // this on the literal 'in_position' meant it never fired after P3b (a live call is long/short),
    // so dismissing a management card fell through and marked a call with an OPEN broker position
    // 'dismissed'.
    if (isLivePosition(call.status)) {
        await db.collection(COLLECTION).updateOne({ id }, { $set: { 'position_state.pending_action': null } })
        logger.info(LOG, `call ${id} management card dismissed (position kept)`)
        return { ok: true, dismissed: 'card' }
    }
    // Terminal, with the reason in a field — 'dismissed' was a lifecycle status only for calls,
    // which is exactly the divergence being removed. Ideas have always closed with a reason.
    await db.collection(COLLECTION).updateOne({ id }, { $set: {
        status: 'closed', closedReason: 'dismissed', closedAt: Date.now(),
    } })
    logger.info(LOG, `call ${id} dismissed → closed`)
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
export async function reviveCall(id, userId, deps = _deps) {
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId)
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
export async function declineReentry(id, userId, deps = _deps) {
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId, { userId: 1, status: 1 })
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
// the linked idea's broker position through positionManage — the SHARED executor (amend stop/TP,
// partial/full close), which Talos's setups now go through too; the execution reconciler then
// captures fills / resizes exits / finalizes closes off the resulting events. exit_now may also be
// user-initiated without a pending card. Broker-authoritative idempotency: if the position is
// already flat, just clear the card (Hermes reconciles the close).
//
// What stays here is Kairos's own: ownership + status guards, the call→idea indirection (the
// position hangs off the materialized idea, not off the call), manual-mode notification, and
// Hermes's proposal vocabulary — which is already the execution contract, so it needs no mapping.

const _mdeps = {
    getDb,
    getIdea:          async (id)                              => { if (!id) return null; const db = await getDb(); return db.collection(ENTITIES).findOne({ id }) },
    findOpenPosition: (broker, userId, acct, positionId)      => brokerService.findOpenPosition(broker, userId, acct, positionId),
    closePosition:    (broker, userId, acct, positionId, opts)=> brokerService.closePosition(broker, userId, acct, positionId, opts),
    amendOrder:       (broker, userId, acct, orderId, fields) => brokerService.amendOrder(broker, userId, acct, orderId, fields),
    cancelOrder:      (broker, userId, acct, orderId)         => brokerService.cancelOrder(broker, userId, acct, orderId),
    notifyManage:     (call, card)                            => notifyCallManage(call, card),
    // The hours gate the shared executor asks before it touches a broker. Threaded through this
    // desk's deps rather than reached for inside, so a test can say "the venue is open" the same way
    // it says everything else here — and so a missing one fails loudly instead of skipping the gate.
    deferIfClosed:    _sharedManage._deps.deferIfClosed,
    syncIdeaExit:     (ideaId, accountId, leg, patch)         => _sharedManage._deps.syncExit(ideaId, accountId, leg, patch),
}

// The shared executor reads `syncExit`; this module's dep is named `syncIdeaExit` and every test
// harness injects it under that name. Adapt rather than rename — the indirection is one line, a
// rename would be a silent no-op in any harness that missed it.
const _toSharedDeps = (deps) => ({ ...deps, syncExit: deps.syncIdeaExit })

// The main account's open-position linkage on the idea (broker/account/positionId/entry qty). Pure.
export function _resolveMainLink(idea, call) {
    const acct  = call?.main_account_id ?? null
    const links = Array.isArray(idea?.brokerOrders) ? idea.brokerOrders : []
    const slot  = links.find(b => b?.positionId != null && (acct == null || String(b.accountId) === String(acct)))
        ?? links.find(b => b?.positionId != null)
    if (!slot) return null
    return { broker: slot.broker, accountId: slot.accountId, positionId: slot.positionId, quantity: Number(slot.quantity) || 0 }
}

// The mechanical half of management now lives in positionManage (shared with Talos). Re-exported
// under their historical underscore names: they are imported by name from this module in several
// places, and a rename would be churn with no reader benefit.
export const _resolveAllLinks      = _sharedManage.resolveAllLinks
export const _workingExit          = _sharedManage.workingExit
export const _partialQty           = _sharedManage.partialQty
export const _manageAppliedUpdate  = _sharedManage.manageAppliedUpdate

// Handle an in-position management action. verb ∈ MANAGE_VERBS. Accept executes the pending proposal
// (exit_now also works bare); dismiss clears the card.
export async function manageCall(id, userId, verb, deps = _mdeps) {
    if (!_sharedManage.MANAGE_VERBS.has(verb)) return { ok: false, reason: 'bad_action' }
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId)
    if (err) return { ok: false, reason: err }
    // Post-P3b a live call is 'long'/'short'; the old 'in_position' literal matched nothing, which
    // rejected every management action Hermes had just proposed.
    if (!isLivePosition(call.status)) return { ok: false, reason: 'not_in_position' }

    const ps  = call.position_state ?? {}
    const now = Date.now()

    // Hermes already speaks the execution contract (new_stop / size_pct), so there is nothing to
    // translate here — unlike Talos, which has its own proposal vocabulary.
    const { proposal, err: pErr } = _sharedManage.resolveProposal(ps.pending_action, verb)
    if (pErr) return { ok: false, reason: pErr }

    // A call's position hangs off the idea it materialized at confirm — that doc holds the broker
    // linkage. (A setup holds its own, which is why the executor takes the holder separately.)
    const idea = await deps.getIdea(call.linked_idea_id)
    if (!idea) return { ok: false, reason: 'idea_not_found' }

    // Manual (broker-less): notify the instruction + record intent; the user acts at their broker.
    if (deriveMode(call.broker) === 'manual') {
        await deps.notifyManage(call, { verdict: verb, proposal, manual: true })
        await db.collection(COLLECTION).updateOne({ id }, _sharedManage.manageAppliedUpdate(verb, proposal, ps, {}, now))
        return { ok: true, manual: true, verb }
    }

    return _sharedManage.applyManage({
        entity: call, holder: idea, verb, proposal, userId, nowMs: now, deps: _toSharedDeps(deps),
    })
}

export const kairosHandoffService = { confirmCall, editCall, dismissCall, manageCall, reviveCall, declineReentry }
