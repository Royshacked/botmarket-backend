import { getDb } from '../providers/mongodb.provider.js'
import { ideaService } from '../api/trade-ideas/tradeIdeas.service.js'
import { placeOrdersForIdea } from '../api/trade-ideas/ideaExecution.service.js'
import { notifyManualEntry, entryLegFromIdea } from './manualNotify.service.js'
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

// Map a confirmed call + its fired proposal to a saveIdea() input: an IMMEDIATE market entry
// with the discretionary stop/TP as price levels. saveIdea builds the condition trees, resolves
// the broker symbol, and re-measures basisOffset — so the placed idea lives in the normal system.
export function buildIdeaFromCall(call, proposal, direction) {
    // Direction is the ARMED zone's side (a 'both'-bias call can fire either way); fall back to bias.
    const dir = direction ?? (call?.bias === 'short' ? 'short' : 'long')
    const tp = Array.isArray(proposal?.take_profit) ? proposal.take_profit[0]?.price : null
    return {
        asset:         call?.asset,
        asset_class:   call?.asset_class ?? null,
        direction:     dir,
        quantity:      proposal?.size ?? null,
        immediate:     true,                                     // market entry now
        stop_loss:     proposal?.stop != null ? String(proposal.stop) : undefined,
        take_profit:   tp != null ? String(tp) : undefined,
        accounts:      Array.isArray(call?.accounts) ? call.accounts : [],
        mainAccountId: call?.main_account_id ?? null,
        notes:         `Kairos call ${call?.id}${proposal?.rationale ? ` — ${proposal.rationale}` : ''}`,
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
    const saved = await deps.saveIdea(buildIdeaFromCall(call, proposal, armedZone?.side), userId)
    if (!saved?.ok) return { ok: false, reason: saved?.reason ?? 'idea_create_failed' }
    const idea = saved.idea

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

    await db.collection(COLLECTION).updateOne(
        { id },
        { $set: { status: 'confirmed', linked_idea_id: idea.id, confirmed_at: new Date().toISOString() } },
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

// Dismiss any surfaced card.
export async function dismissCall(id, userId, isAdmin = false, deps = _deps) {
    const db = await deps.getDb()
    const { call, err } = await _loadOwned(db, id, userId, isAdmin, { user_id: 1 })
    if (err) return { ok: false, reason: err }
    await db.collection(COLLECTION).updateOne({ id }, { $set: { status: 'dismissed' } })
    logger.info(LOG, `call ${id} dismissed`)
    return { ok: true }
}

export const kairosHandoffService = { confirmCall, editCall, dismissCall }
