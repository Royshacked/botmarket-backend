// WHO a queued action belongs to, and what has to happen to them when the user cancels it.
//
// A queued item is a decision taken somewhere else — an Atlas review, a Kairos call arming, a
// Talos setup filling in, a ticket. Cancelling it from the list is therefore never just a delete:
// the surface that decided still believes the thing is happening. Atlas would re-propose the same
// trim at the next review, having no idea you turned it down; a call would sit armed for an entry
// that will never be confirmed.
//
// REGISTRY, not a switch. The queue itself stays blind to origin kind — same invariant the entity
// envelope holds (docs/architecture/entity-model.md): adding a sixth origin is one entry here, with no change to the
// queue, the sweep, or the list. `originRegistry.test.js` asserts every kind that can be ENQUEUED
// has a handler, so a new producer cannot ship with a cancel that silently does nothing.

import { getDb } from '../../providers/mongodb.provider.js'
import { logger } from '../logger.service.js'
import { ENTITIES } from '../entity/entityCollection.js'

const LOG = '[pendingAction:origin]'

/**
 * A holding in an Atlas book. Cancelling reverses nothing at the broker (that is the whole point —
 * nothing executed), so the work is: clear any intent stamped on the doc, and RECORD the refusal
 * where the next review will read it.
 *
 * The record matters more than the clearing. Atlas proposes from the book's current state, so a
 * cancelled trim is invisible to it and comes back next week identically — the user says no, and
 * the desk asks again, which reads as not listening. `rebalance_history` is the same shape as
 * conviction_history (append + $slice), for the same reason: the next review wants the trajectory.
 */
async function _cancelPortfolioItem(record) {
    const db = await getDb()
    const at = Date.now()

    // Only the marks an accepted change stamps on the doc. Written defensively: phase 1 defers
    // BEFORE any of them are set, but a later producer that stamps first must not leave them.
    const clear = {
        trim:   { pendingTrimQty: '', pendingCloseReason: '' },
        exit:   { pendingCloseReason: '' },
        add_to: { pendingAddQty: '' },
        entry:  {},
    }[record?.action?.type] ?? {}

    const res = await db.collection(ENTITIES).updateOne(
        { id: record.origin.entityId, userId: record.userId },
        {
            ...(Object.keys(clear).length ? { $unset: clear } : {}),
            $push: { rebalance_history: { $each: [{
                at,
                action:   record.action?.type ?? null,
                outcome:  'cancelled',
                // WHY it was even queued — "you declined it" and "it expired unexecuted" are
                // different signals to the next review, and only the first is a preference.
                queued:   record.queuedReason ?? null,
                decidedAt: record.decidedAt ?? null,
            }], $slice: -12 } },
        },
    )
    if (res.matchedCount === 0) {
        // The holding is gone (exited and deleted between queue and cancel). Not an error: the
        // queued action is moot, and the cancel has already achieved what it meant to.
        logger.info(LOG, `holding ${record.origin.entityId} no longer exists — nothing to notify`)
        return { ok: true, noted: false }
    }
    return { ok: true, noted: true }
}

/**
 * Run a released action for real, now that its venue is open.
 *
 * REPLAYED THROUGH THE ORIGINAL FUNCTION, never a copy. `_trimItem` and friends own per-leg sizing,
 * broker capability checks, the advisory weight write and the manual-mode branch; a second
 * implementation here would start correct and drift. The hours gate inside them is the same one
 * that queued this in the first place — so if the venue has closed again in the meantime (a user
 * opening the list after hours), it simply re-queues onto the SAME row via the enqueue dedupe and
 * reports itself deferred. Executing early is impossible by construction rather than by a check.
 */
async function _executePortfolioItem(record) {
    const a = record.action ?? {}
    // Verb check BEFORE anything expensive: answering "I don't know that verb" should not open a
    // database connection, and a bad verb is a programming error, not a runtime condition.
    if (!['trim', 'exit', 'add_to'].includes(a.type)) return { ok: false, reason: 'unknown_action' }

    // LAZY, and it has to be: portfolioRebalance imports the gate, the gate imports this file, so a
    // top-level import here closes the cycle and one of the three modules would evaluate against
    // half-initialised bindings. Resolved at call time instead — the same dodge chat.service uses
    // for chatWs. (This is also the honest signal that execution logic lives THERE, not here.)
    const { _trimItem, _exitItem, _addToItem } = await import('../../api/portfolio/portfolioRebalance.service.js')

    const db     = await getDb()
    const itemId = record.origin.entityId

    switch (a.type) {
        case 'trim':
            return _trimItem(db, itemId, record.userId, {
                reduceFraction: a.reduceFraction, targetAllocationRatio: a.targetAllocationRatio ?? null,
            })
        case 'exit':
            return _exitItem(db, itemId, record.userId, a.reason ?? 'rebalance')
        case 'add_to':
            return _addToItem(db, itemId, record.userId, {
                addFraction: a.addFraction, targetAllocationRatio: a.targetAllocationRatio ?? null,
            })
        default:
            return { ok: false, reason: 'unknown_action' }
    }
}

/**
 * The three EXECUTION kinds — a legacy idea, a Kairos call, a Talos setup. What queues for them is
 * not a discretionary decision but a monitor's: a stop or target that tripped while the venue was
 * shut. There is exactly one verb (`exit`), so these three share both handlers.
 *
 * Replayed through positionMonitor's own closer, so an overnight stop and an in-hours stop place
 * identical orders — including a partial (a scaled TP closes a slice, not the position).
 */
async function _executeMonitorExit(record) {
    const a = record.action ?? {}
    if (a.type !== 'exit') return { ok: false, reason: 'unknown_action' }

    // Lazy for the same reason as above: positionMonitor imports the gate, which imports this file.
    const { executeDeferredClose } = await import('../../monitoring/positionMonitor.js')
    return executeDeferredClose(record.origin.entityId, record.userId, {
        leg: a.leg ?? null, reason: a.reason ?? 'manual', quantity: a.quantity ?? null, tag: a.tag ?? null,
    })
}

/**
 * Cancelling a monitor exit is NOT offered in the list (`cancellable:false`) — the stop is still
 * breached, so dropping the row would re-queue it on the next tick. This exists for the one case
 * that can still reach it: an admin or a future caller dropping the row directly. It clears the
 * deferral so the monitor is free to decide again, which is the honest outcome — not a promise
 * that the exit is off.
 */
async function _cancelMonitorExit(record) {
    const db  = await getDb()
    const res = await db.collection(ENTITIES).updateOne(
        { id: record.origin.entityId, userId: record.userId, orderState: 'awaiting_market_close' },
        { $unset: { orderState: '', pendingCloseReason: '' } },
    )
    if (res.matchedCount === 0) {
        logger.info(LOG, `${record.origin.entityId} is no longer awaiting a deferred close — nothing to clear`)
        return { ok: true, noted: false }
    }
    return { ok: true, noted: true }
}

// ── In-position management, accepted while the venue was shut ────────────────
//
// The OTHER thing that can queue against a call / setup / idea: the user accepting a monitor's
// management proposal (tighten the stop, bank a third, get flat) after hours. Nothing about it is
// discretionary once accepted — but nothing about it can reach a broker either, so it waits.

/** The verbs positionManage executes. Their presence is what tells a manage row from a monitor exit. */
const MANAGE_VERBS = new Set(['move_stop', 'take_partial', 'exit_now', 'let_run'])

/**
 * Replay an accepted management action at the open, through the SAME executor that would have run
 * it there and then. Both documents are re-read first: hours have passed, and the position may have
 * been closed, partly filled or reconciled since — `applyManage` is broker-authoritative about all
 * three, so handing it fresh docs is the whole of the freshness requirement.
 *
 * Lazily imported, like the two above: positionManage now asks the gate, the gate imports this file.
 */
async function _executeManage(record) {
    const a = record.action ?? {}
    if (!MANAGE_VERBS.has(a.type)) return { ok: false, reason: 'unknown_action' }

    const db     = await getDb()
    const entity = await db.collection(ENTITIES).findOne({ id: record.origin.entityId, userId: record.userId })
    if (!entity) return { ok: false, reason: 'not_found' }

    // A setup holds its own broker linkage, so entity and holder are one document; a call's position
    // hangs off the idea it materialized. The id was captured at accept time rather than re-derived,
    // because which doc holds the linkage is the DESK's knowledge and this file has none.
    const holderId = a.holderId ?? entity.id
    const holder   = holderId === entity.id
        ? entity
        : await db.collection(ENTITIES).findOne({ id: holderId, userId: record.userId })
    if (!holder) return { ok: false, reason: 'not_found' }

    const { applyManage } = await import('../positionManage.service.js')
    return applyManage({ entity, holder, verb: a.type, proposal: a.proposal ?? {}, userId: record.userId })
}

/**
 * Dropping an accepted management action. Nothing executed, so there is nothing to reverse at the
 * broker — what has to be undone is the PROPOSAL still sitting on the position, which is what the
 * user was accepting. Left there it keeps its card up offering a decision they have now taken twice
 * (yes, then no), and the next wake compares against a pending action that no longer means anything.
 *
 * Safe to call twice and silent about a missing target, per the contract on ORIGINS.
 */
async function _cancelManage(record) {
    const db  = await getDb()
    const res = await db.collection(ENTITIES).updateOne(
        { id: record.origin.entityId, userId: record.userId },
        { $set: { 'position_state.pending_action': null } },
    )
    if (res.matchedCount === 0) {
        logger.info(LOG, `${record.origin.entityId} no longer exists — no proposal to clear`)
        return { ok: true, noted: false }
    }
    return { ok: true, noted: true }
}

/**
 * Which KIND OF WORK a row is, for the three execution kinds — a monitor's exit, or a user's
 * accepted management action.
 *
 * Dispatched on the VERB, not on `queuedBy`, and the difference from `_byDecider` above is worth
 * stating. A holding's two kinds both spell `exit`, so only the decider can separate them. Here they
 * never collide: a monitor exit is `exit`, a management action is `move_stop` / `take_partial` /
 * `exit_now` / `let_run`. The verb is therefore the more robust tell — rows written before
 * `queuedBy` existed default to 'user', and dispatching those to the manage handler would send a
 * legacy overnight stop through the wrong executor.
 */
const _byWork = (onManage, onExit) => (record) =>
    (MANAGE_VERBS.has(record?.action?.type) ? onManage : onExit)(record)

/**
 * One entry per origin kind.
 *
 * `cancel(record)` must be safe to call twice (the list can double-fire on a slow network) and must
 * never throw for a missing target — the queue transition already happened, and a cancel that
 * half-completes is worse than one that notes nothing.
 *
 * `execute(record)` returns the change's own `{ ok, reason }` shape, so the caller can tell a
 * refusal ("too small", "no position") from a re-deferral (`deferred:true`) from a success.
 */
/**
 * A holding carries BOTH kinds of queued work: a review's discretionary change AND the monitor's
 * own exits (a portfolio leg has a stop like anything else). They are NOT interchangeable, and the
 * verb alone cannot tell them apart — both spell `exit`.
 *
 * The difference bites: a monitor exit can be PARTIAL (a scaled target closes a slice) and carries
 * the leg + fired-exit tag, none of which `_exitItem` understands — it closes the whole position.
 * Running a scaled TP through it would liquidate a holding that was only meant to be trimmed. So
 * WHO decided is the dispatch, not what it is called.
 */
const _byDecider = (onUser, onMonitor) => (record) =>
    (record?.queuedBy === 'monitor' ? onMonitor : onUser)(record)

const ORIGINS = Object.freeze({
    portfolio_item: {
        desk:    'portfolio',
        cancel:  _byDecider(_cancelPortfolioItem, _cancelMonitorExit),
        execute: _byDecider(_executePortfolioItem, _executeMonitorExit),
    },
    // The execution kinds. TWO things queue for these: a monitor's exit (a stop or target that
    // tripped while the venue was shut) and a user's accepted management action. `_byWork` tells
    // them apart by verb — see the note on it.
    call:  { desk: 'kairos', cancel: _byWork(_cancelManage, _cancelMonitorExit), execute: _byWork(_executeManage, _executeMonitorExit) },
    setup: { desk: 'mentor', cancel: _byWork(_cancelManage, _cancelMonitorExit), execute: _byWork(_executeManage, _executeMonitorExit) },
    // The Idea desk is archived, so its rows speak as Axl — the same fallback its cards take.
    idea:  { desk: 'axl',    cancel: _byWork(_cancelManage, _cancelMonitorExit), execute: _byWork(_executeManage, _executeMonitorExit) },
})

export const ORIGIN_KINDS = Object.keys(ORIGINS)

/** Can this origin kind be queued at all? The gate refuses anything else — see executionGate. */
export function hasOriginHandler(kind) {
    return Object.hasOwn(ORIGINS, String(kind))
}

/** The desk a kind belongs to, for the row's tag. Null for an unregistered kind. */
export function deskForOrigin(kind) {
    return ORIGINS[String(kind)]?.desk ?? null
}

/**
 * Tell the origin its queued action was cancelled. Never throws: the caller has already moved the
 * queue record to `cancelled`, and an origin that could not be notified must not undo that — the
 * user's cancellation is the fact, the notification is the follow-up.
 * @returns {Promise<{ ok: boolean, reason?: string, noted?: boolean }>}
 */
export async function cancelOrigin(record) {
    const kind    = record?.origin?.kind
    const handler = ORIGINS[String(kind)]?.cancel
    if (!handler) {
        logger.warn(LOG, `no cancel handler for origin '${kind}' — ${record?.id} cancelled without notifying its desk`)
        return { ok: false, reason: 'no_origin_handler' }
    }
    try {
        return await handler(record)
    } catch (err) {
        logger.error(LOG, `cancel handler failed for origin '${kind}'`, err.message)
        return { ok: false, reason: 'error' }
    }
}

/**
 * Run a released action. Unlike cancel this DOES surface failure: the user pressed Execute and is
 * waiting to be told whether it went through, so a refusal must reach them rather than be logged.
 * @returns {Promise<{ ok: boolean, reason?: string, deferred?: boolean }>}
 */
export async function executeOrigin(record) {
    const kind    = record?.origin?.kind
    const handler = ORIGINS[String(kind)]?.execute
    if (!handler) {
        logger.error(LOG, `no execute handler for origin '${kind}' — ${record?.id} cannot be run`)
        return { ok: false, reason: 'no_origin_handler' }
    }
    try {
        return await handler(record)
    } catch (err) {
        logger.error(LOG, `execute handler failed for origin '${kind}'`, err.message)
        return { ok: false, reason: 'error' }
    }
}

export const originRegistry = { ORIGIN_KINDS, hasOriginHandler, deskForOrigin, cancelOrigin, executeOrigin }
