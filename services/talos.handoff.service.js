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
 *      • `let_run` is TWO things wearing one word, and only one of them is an action. Bare, it is a
 *        decision not to act — the position is already doing what it describes, so there is nothing
 *        to accept. Carrying `{ new_tp }` it is principle 3 of the TP window: Talos asking to move
 *        the target further out because the move has more in it than the plan assumed. The shared
 *        executor has always been able to amend a tp leg; what was missing was a desk willing to
 *        propose it. A bare one is refused as `bad_proposal` — it has no level to place.
 */

const LOG        = '[talos.handoff]'
const COLLECTION = ENTITIES   // setups live in entities as kind:'setup'

/** A setup's acceptable actions — see the verb note above. */
export const SETUP_MANAGE_VERBS = new Set(['move_stop', 'take_partial', 'exit_now', 'let_run'])

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
    if (verb === 'let_run') {
        // `tp` is Talos's field, `new_tp` the executor's — accepted both ways for the same reason
        // move_stop takes `new_stop`. Cancelling the target outright is a separate intent the shared
        // executor already understands, and it is NOT a missing level.
        if (p.cancel_tp === true) return { cancel_tp: true }
        const level = Number(p.new_tp ?? p.tp)
        return { new_tp: Number.isFinite(level) ? level : null }
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
    // A BARE let_run is the decision not to act — real, and journalled by the monitor, but there is
    // nothing here to execute. Only one carrying a level (or an outright cancel) is an action.
    if (verb === 'let_run' && proposal.cancel_tp !== true && !Number.isFinite(proposal.new_tp)) {
        return { ok: false, reason: 'bad_proposal' }
    }

    // Manual (broker-less): tell the user what to do at their own broker and record the intent.
    // The card carries Talos's RAW proposal — its copy is written in its own vocabulary.
    if (knownVenue(setup.broker) === 'manual') {
        await deps.notifyManage(setup, { verdict: verb, proposal: pending?.proposal ?? null, manual: true })
        await db.collection(COLLECTION).updateOne({ id }, manage.manageAppliedUpdate(verb, proposal, ps, {}, now))
        await _moveTargetWindow(db, setup, verb, proposal)
        logger.info(LOG, `setup ${id} manage ${verb} → manual instruction`)
        return { ok: true, manual: true, verb }
    }

    const res = await manage.applyManage({ entity: setup, holder: setup, verb, proposal, userId, nowMs: now, deps })
    if (res.ok) await _moveTargetWindow(db, setup, verb, proposal)
    return res
}

/**
 * Carry the WAKE LEVEL with the target when a `let_run` moves it.
 *
 * The shared executor amends the resting limit; the ladder Talos wakes on is this desk's own, and
 * nothing else would move it. Left behind, Talos would keep opening the conversation at the window
 * of a target that is no longer there — asking to bank into a level the user just declined.
 *
 * The rung keeps its authored BREADTH and re-arms at the new level: "let it run to X" is an
 * instruction to have the conversation again at X, not to stop having it.
 */
async function _moveTargetWindow(db, setup, verb, proposal) {
    if (verb !== 'let_run' || !Number.isFinite(proposal?.new_tp)) return
    const targets = movedLadder(setup.position_state ?? {}, proposal.new_tp, amendedLevel(setup))
    if (!targets) return
    await db.collection(COLLECTION).updateOne({ id: setup.id }, { $set: { 'position_state.targets': targets } })
}

/**
 * The level the executor will actually amend — read through the executor's OWN helpers rather than
 * re-derived, so the two cannot drift into disagreeing about which rung a `let_run` was about.
 * Null when there is nothing resting (then the ladder falls back to the nearest un-asked rung).
 */
export function amendedLevel(setup) {
    const link = manage.resolveAllLinks(setup, setup)[0] ?? null
    const ord  = link ? manage.workingExit(setup, link.accountId, 'tp') : null
    const px   = Number(ord?.price)
    return Number.isFinite(px) ? px : null
}

/**
 * The ladder with the rung under discussion moved to `newTp`, keeping its breadth. Null when there
 * is nothing to move. Pure.
 *
 * WHICH RUNG: the one whose limit is the order being amended (`restingAt`), because that is the rung
 * the broker change lands on — matching by anything else would move a window away from the order it
 * belongs to and leave a second rung pointing at a level nothing rests on. It falls back to the
 * nearest un-asked rung when no order is resting: an alert-only setup has a ladder and no orders,
 * and it is still the rung Talos proposed against.
 */
export function movedLadder(ps, newTp, restingAt = null) {
    const list = ps?.targets ?? []
    if (!list.length || !Number.isFinite(newTp)) return null

    const matched = Number.isFinite(restingAt)
        ? list.findIndex(t => Number.isFinite(Number(t?.resting)) && Math.abs(Number(t.resting) - restingAt) <= Math.max(Math.abs(restingAt), 1) * 1e-9)
        : -1
    const found = matched !== -1 ? matched : list.findIndex(t => t?.hit_at == null)
    const idx   = found === -1 ? list.length - 1 : found
    const rung  = list[idx]

    const breadth = (Number.isFinite(rung?.price) && Number.isFinite(rung?.resting))
        ? Math.abs(rung.resting - rung.price) : 0
    const isLong = (ps?.entry?.direction ?? 'long') !== 'short'
    // No breadth to carry → it was an exact level, and an exact level has no window to wake in.
    const wake = breadth > 0 ? (isLong ? newTp - breadth : newTp + breadth) : null

    return list.map((t, k) => (k === idx ? { ...t, price: wake, resting: newTp, hit_at: null } : t))
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

export const talosHandoffService = { manageSetup, dismissSetupCard, toExecutionProposal, movedLadder, amendedLevel, SETUP_MANAGE_VERBS }
