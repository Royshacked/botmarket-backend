import { getDb } from '../providers/mongodb.provider.js'
import { ENTITIES } from './entity/entityCollection.js'
import { notifySetupManage, notifySetupLimitDisarm } from './tradeNotify.service.js'
import { ownsEntity } from './entity/entityCrud.service.js'
import { makeEntityRepo } from './entity/entityRepo.service.js'
import { isLivePosition } from './entity/vocabulary.js'
import { disarmedSetupPatch } from './setup.schema.js'
import { cancelRestingEntryOrders } from './restingOrders.service.js'
import * as manage from './positionManage.service.js'
import { logger } from './logger.service.js'

/**
 * Mentor/Talos's in-position handoff — the user acting on a `setup_manage` card.
 *
 * Talos has been writing `position_state.pending_action` since Phase 5, in the same shape Hermes
 * writes for a call, but there was nowhere to say yes: the card arrived and the proposal died there.
 * This is that endpoint's service half. The EXECUTION is the shared one (positionManage); what lives
 * here is what belongs to this desk.
 *
 * TWO THINGS ARE MENTOR'S, not the executor's:
 *
 * 1. THE DIALECT. Talos proposes in the vocabulary of its own prompt — `{ stop, why }` for a stop
 *    move, `{ leg, quantity, size_pct }` for a partial (the watched target's own size, resolved by
 *    the monitor). Hermes said `{ new_stop }` / `{ size_pct }`. The translation happens HERE, on
 *    the way in, so the shared executor never has to know which desk is calling. Note the NOTIFY
 *    path deliberately gets the RAW proposal: the manual-mode card is Talos's copy.
 *
 * 2. WHICH VERBS ARE EVEN ACTIONABLE. A setup's menu is not a call's:
 *      • `add_leg` is NOT accepted here. Talos already builds the order plan for a printing second
 *        leg and parks it as `pendingOrder` / `awaiting_confirm` — that leg is placed by CONFIRMING
 *        an order, the same path a first entry takes. Executing it here as well would place the
 *        size twice. It is refused with its own reason so the caller can route to the confirm.
 *      • `let_run` is gone. Moving a target OUT is an edit of the plan, not a monitor act, and a
 *        bare "letting it run" is a hold (docs/design/talos-per-candle.md).
 */

const LOG        = '[talos.handoff]'

/** A setup's acceptable actions — see the verb note above. */
export const SETUP_MANAGE_VERBS = new Set(['move_stop', 'take_partial', 'exit_now'])

/**
 * Talos's proposal → the shared execution contract. Unknown/absent fields resolve to null rather
 * than to a guess: the executor refuses a move to a non-finite level, which is the correct outcome
 * for a proposal that never carried one.
 */
export function toExecutionProposal(verb, raw) {
    const p = raw ?? {}
    if (verb === 'move_stop') {
        // `stop` is Talos's field; `new_stop` is accepted too so a proposal already in the shared
        // dialect (a future desk, a replayed card) isn't silently dropped.
        const level = Number(p.new_stop ?? p.stop)
        return { new_stop: Number.isFinite(level) ? level : null, ref: p.ref ?? p.why ?? null }
    }
    if (verb === 'take_partial') {
        // The monitor already resolved the watched leg's size into a share of the ORIGINAL position.
        const pct = Number(p.size_pct)
        return { size_pct: Number.isFinite(pct) ? pct : null }
    }
    return {}
}

/**
 * The entity repo over whatever `getDb` this call was handed — every read and write here goes
 * through it rather than reaching for `db.collection(ENTITIES)` directly, which is the one write
 * funnel the rest of the execution path already uses (entity-model P1b). Built per call so a test's
 * fake db is still seen.
 */
const repo = (deps) => makeEntityRepo({ coll: async () => (await deps.getDb()).collection(ENTITIES) })

const _deps = {
    getDb,
    // The hours gate the shared executor asks before it touches a broker — see applyManage. Threaded
    // through the desk's deps like everything else it needs, so a missing one fails loudly rather
    // than quietly skipping the gate.
    deferIfClosed:    manage._deps.deferIfClosed,
    findOpenPosition: manage._deps.findOpenPosition,
    closePosition:    manage._deps.closePosition,
    amendOrder:       manage._deps.amendOrder,
    cancelOrder:      manage._deps.cancelOrder,
    notifyManage:     (setup, card) => notifySetupManage(setup, card),
    notifyDisarm:     (setup, reason) => notifySetupLimitDisarm(setup, reason),
}

async function _loadOwned(deps, id, userId) {
    const setup = await repo(deps).getById(id)
    if (!setup) return { err: 'not_found' }
    if (!ownsEntity(setup, userId)) return { err: 'forbidden' }
    return { setup }
}

/**
 * Accept a pending management proposal on a live setup. `exit_now` also works bare (the user can
 * always choose to get flat, whether or not Talos asked).
 *
 * A setup holds its own broker linkage — execution writes `brokerOrders` / `exitOrders` onto the
 * setup doc itself — so entity and holder are the same document here, unlike a call.
 */
export async function manageSetup(id, userId, verb, deps = _deps) {
    if (verb === 'add_leg') return { ok: false, reason: 'confirm_order' }
    if (!SETUP_MANAGE_VERBS.has(verb)) return { ok: false, reason: 'bad_action' }

    const { setup, err } = await _loadOwned(deps, id, userId)
    if (err) return { ok: false, reason: err }
    if (!isLivePosition(setup.status)) return { ok: false, reason: 'not_in_position' }

    const ps  = setup.position_state ?? {}
    const now = Date.now()

    const pending = ps.pending_action
    const { proposal, err: pErr } = manage.resolveProposal(pending, verb, (raw) => toExecutionProposal(verb, raw))
    if (pErr) return { ok: false, reason: pErr }
    // A stop move with no level, or a partial with no size, cannot be executed — and must not
    // reach the broker to find that out. The card stays pending: the user declined nothing, the
    // proposal was simply unusable, and clearing it would hide that.
    if (verb === 'move_stop'    && !Number.isFinite(proposal.new_stop)) return { ok: false, reason: 'bad_proposal' }
    if (verb === 'take_partial' && !Number.isFinite(proposal.size_pct)) return { ok: false, reason: 'bad_proposal' }

    // The executor decides WHETHER it can act; this desk supplies only what the user reads.
    //
    // Talos used to ask the venue itself (`knownVenue(setup.broker) === 'manual'`) and branch before
    // calling in, which made this desk the only thing standing between a broker-less account and the
    // three broker calls inside executeManage. A second desk would not have known to do the same.
    const res = await manage.applyManage({ entity: setup, holder: setup, verb, proposal, userId, nowMs: now, deps })

    // Self-executed venue: tell the user what to do at their own institution, then record the
    // intent. NOTIFY FIRST and un-guarded, deliberately — an instruction only a human can carry out
    // must not be written down as applied if the human was never told. The card carries Talos's RAW
    // proposal: its copy is written in its own vocabulary, which is why this stayed at the desk.
    if (res.selfExecuted) {
        await deps.notifyManage(setup, { verdict: verb, proposal: pending?.proposal ?? null, manual: true })
        await repo(deps).update(id, manage.manageAppliedUpdate(verb, proposal, ps, {}, now))
        logger.info(LOG, `setup ${id} manage ${verb} → manual instruction`)
        return { ok: true, manual: true, verb }
    }

    return res
}

/**
 * Dismiss a management card without touching the position — the "no thanks" half of the same card.
 * Mirrors dismissCall's live branch, and deliberately does NOT have its terminal branch: a setup
 * that isn't in a position has no management card to dismiss, so there is nothing here that could
 * close one.
 */
export async function dismissSetupCard(id, userId, deps = _deps) {
    const { setup, err } = await _loadOwned(deps, id, userId)
    if (err) return { ok: false, reason: err }
    if (!isLivePosition(setup.status)) return { ok: false, reason: 'not_in_position' }
    await repo(deps).patch(id, { 'position_state.pending_action': null })
    logger.info(LOG, `setup ${id} management card dismissed (position kept)`)
    return { ok: true, dismissed: 'card' }
}

/**
 * Immediately cancel a pending limit order and return the setup to 'waiting'.
 *
 * The monitor's own disarm path fires on the next Talos wake — this is the fast path for a user who
 * wants to pull the order now rather than waiting for the next poll. Only applies to 'hit' limit
 * setups (the limit order was confirmed but not yet filled). A setup already at 'waiting' or 'looking'
 * has no broker order to cancel.
 */
export async function disarmSetup(id, userId, deps = _deps) {
    const { setup, err } = await _loadOwned(deps, id, userId)
    if (err) return { ok: false, reason: err }
    if (setup.status !== 'hit' || setup.entry_mode !== 'limit') {
        return { ok: false, reason: 'not_a_pending_limit' }
    }

    // Only `placed` has an order AT the broker; awaiting_confirm / awaiting_market are plans nobody
    // placed yet. The cancel and the field reset are both the shared ones — see _disarmLimit, which
    // is the same disarm reached by a different door.
    if (setup.orderState === 'placed') {
        await cancelRestingEntryOrders(setup, userId, { log: LOG, cancelOrder: deps.cancelOrder })
    }

    await repo(deps).patch(id, disarmedSetupPatch())

    try { await deps.notifyDisarm(setup, 'manual') }
    catch (notifyErr) { logger.warn(LOG, `disarmSetup: notify failed for ${id}: ${notifyErr.message}`) }

    logger.info(LOG, `setup ${id} limit order disarmed manually`)
    return { ok: true }
}

export const talosHandoffService = { manageSetup, dismissSetupCard, disarmSetup, toExecutionProposal, SETUP_MANAGE_VERBS }
