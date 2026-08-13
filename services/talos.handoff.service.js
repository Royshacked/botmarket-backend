import { getDb } from '../providers/mongodb.provider.js'
import { ENTITIES } from './entity/entityCollection.js'
import { notifySetupManage } from './tradeNotify.service.js'
import { ownsEntity } from './entity/entityCrud.service.js'
import { isLivePosition } from './entity/vocabulary.js'
import { knownVenue } from './venue.resolve.service.js'
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
 *    move, `{ fraction: 'third'|'half'|'two_thirds' }` for a partial — because that is what reads
 *    naturally to the model being asked the question. Hermes says `{ new_stop }` / `{ size_pct }`.
 *    Neither is wrong; the translation happens HERE, on the way in, so the shared executor never
 *    has to know which desk is calling. Note the NOTIFY path deliberately gets the RAW proposal:
 *    the manual-mode card is Talos's copy, written in Talos's words.
 *
 * 2. WHICH VERBS ARE EVEN ACTIONABLE. A setup's menu is not a call's:
 *      • `add_leg` is NOT accepted here. Talos already builds the order plan for a printing second
 *        leg and parks it as `pendingOrder` / `awaiting_confirm` — that leg is placed by CONFIRMING
 *        an order, the same path a first entry takes. Executing it here as well would place the
 *        size twice. It is refused with its own reason so the caller can route to the confirm.
 *      • `let_run` is a decision NOT to act. Talos sends it with no proposal and no card actions,
 *        so there is nothing to accept — the position is already doing what let_run describes.
 */

const LOG        = '[talos.handoff]'
const COLLECTION = ENTITIES   // setups live in entities as kind:'setup'

/** A setup's acceptable actions — see the verb note above. */
export const SETUP_MANAGE_VERBS = new Set(['move_stop', 'take_partial', 'exit_now'])

/**
 * Talos's fraction words → a percentage of the ORIGINAL position. Words rather than numbers is a
 * deliberate choice in the assess prompt (a model asked for a number invents precision it doesn't
 * have), so the numbers are chosen here, once. Rounded to 2dp: the executor caps at what's live and
 * "Banked 33.33%" is what the journal should read, not 33.33333333333333.
 */
export const FRACTION_PCT = { third: 33.33, half: 50, two_thirds: 66.67 }

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
        const pct = Number(p.size_pct ?? FRACTION_PCT[p.fraction])
        return { size_pct: Number.isFinite(pct) ? pct : null }
    }
    return {}
}

const _deps = {
    getDb,
    findOpenPosition: manage._deps.findOpenPosition,
    closePosition:    manage._deps.closePosition,
    amendOrder:       manage._deps.amendOrder,
    cancelOrder:      manage._deps.cancelOrder,
    syncExit:         manage._deps.syncExit,
    notifyManage:     (setup, card) => notifySetupManage(setup, card),
}

async function _loadOwned(db, id, userId) {
    const setup = await db.collection(COLLECTION).findOne({ id })
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

    const db = await deps.getDb()
    const { setup, err } = await _loadOwned(db, id, userId)
    if (err) return { ok: false, reason: err }
    if (!isLivePosition(setup.status)) return { ok: false, reason: 'not_in_position' }

    const ps  = setup.position_state ?? {}
    const now = Date.now()

    const pending = ps.pending_action
    const { proposal, err: pErr } = manage.resolveProposal(pending, verb, (raw) => toExecutionProposal(verb, raw))
    if (pErr) return { ok: false, reason: pErr }
    // A stop move with no level, or a partial with no fraction, cannot be executed — and must not
    // reach the broker to find that out. The card stays pending: the user declined nothing, the
    // proposal was simply unusable, and clearing it would hide that.
    if (verb === 'move_stop'    && !Number.isFinite(proposal.new_stop)) return { ok: false, reason: 'bad_proposal' }
    if (verb === 'take_partial' && !Number.isFinite(proposal.size_pct)) return { ok: false, reason: 'bad_proposal' }

    // Manual (broker-less): tell the user what to do at their own broker and record the intent.
    // The card carries Talos's RAW proposal — its copy is written in its own vocabulary.
    if (knownVenue(setup.broker) === 'manual') {
        await deps.notifyManage(setup, { verdict: verb, proposal: pending?.proposal ?? null, manual: true })
        await db.collection(COLLECTION).updateOne({ id }, manage.manageAppliedUpdate(verb, proposal, ps, {}, now))
        logger.info(LOG, `setup ${id} manage ${verb} → manual instruction`)
        return { ok: true, manual: true, verb }
    }

    return manage.applyManage({ entity: setup, holder: setup, verb, proposal, userId, nowMs: now, deps })
}

/**
 * Dismiss a management card without touching the position — the "no thanks" half of the same card.
 * Mirrors dismissCall's live branch, and deliberately does NOT have its terminal branch: a setup
 * that isn't in a position has no management card to dismiss, so there is nothing here that could
 * close one.
 */
export async function dismissSetupCard(id, userId, deps = _deps) {
    const db = await deps.getDb()
    const { setup, err } = await _loadOwned(db, id, userId)
    if (err) return { ok: false, reason: err }
    if (!isLivePosition(setup.status)) return { ok: false, reason: 'not_in_position' }
    await db.collection(COLLECTION).updateOne({ id }, { $set: { 'position_state.pending_action': null } })
    logger.info(LOG, `setup ${id} management card dismissed (position kept)`)
    return { ok: true, dismissed: 'card' }
}

export const talosHandoffService = { manageSetup, dismissSetupCard, toExecutionProposal, SETUP_MANAGE_VERBS }
