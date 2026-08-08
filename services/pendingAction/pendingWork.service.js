// "What is waiting on me" — the ONE read behind both the market-open nudge and the queued list.
//
// Waiting work arrives from two places and neither is going away:
//
//   • a QUEUED ACTION (`pending_actions`) — a trim, exit or scale-in the user confirmed while the
//     venue was shut. It has no entity of its own; the record IS the intent.
//   • an ENTITY awaiting confirmation — an entry whose plan is built and sitting at
//     `awaiting_confirm`, either because its condition fired in hours or because the sweep just
//     unparked it. The entity IS the intent; there is no separate record.
//
// They are deliberately NOT merged into one collection. Copying an entity into the queue would give
// the same order two owners and two states to drift apart; the union belongs in a read, not in the
// storage. So this normalizes both into one row shape and everything downstream — the count in
// Axl's card, the Floor list, the execute/cancel routing — speaks that shape and never asks where
// a row came from except to act on it.
//
// See docs/architecture/off-hours-queue.md.

import { logger } from '../logger.service.js'
import { entityRepo } from '../entity/entityRepo.service.js'
import { kindForDoc } from '../entity/envelope.js'
import { listOpen, STATES } from './pendingAction.repo.js'

const LOG = '[pendingWork]'

/** Entity order states that mean "this is waiting for the user to press the button". */
export const WAITING_ORDER_STATES = ['awaiting_confirm']

/** Where a row came from — decides which endpoint executes it and what cancel means. */
export const SOURCES = Object.freeze({ QUEUE: 'queue', ENTITY: 'entity' })

/**
 * A queued action → a row.
 * `released` means the market has since opened and it is executable now; `queued` means it is still
 * waiting for that. Both are shown, because "3 waiting, 1 of them not until Monday" is the honest
 * picture and hiding the not-yet-ready ones is how a decision gets forgotten.
 */
function _fromQueue(rec) {
    return {
        id:        rec.id,
        source:    SOURCES.QUEUE,
        ready:     rec.state === STATES.RELEASED,
        asset:     rec.asset,
        assetClass: rec.assetClass ?? null,
        direction: rec.direction ?? null,
        action:    rec.action,
        origin:    rec.origin,
        // Whether the LIST offers to drop it. A discretionary decision is the user's to change; a
        // monitor's exit is the consequence of a stop they already set, and dropping the row would
        // only re-queue it next tick while the stop is still breached. Older rows predate the flag
        // and were all user decisions, hence the default.
        cancellable: rec.cancellable !== false,
        queuedBy:  rec.queuedBy ?? 'user',
        decidedAt: rec.decidedAt ?? null,
        nextOpenMs: rec.nextOpenMs ?? null,
        queuedReason: rec.queuedReason ?? null,
    }
}

/**
 * An entity awaiting confirmation → the same row.
 *
 * `action.type` is 'entry' whatever the kind: an idea, a holding and a setup all mean "open this
 * position" here, and the KIND (which decides the dialog and the desk tag) rides in `origin`. That
 * split is what lets the list route by action while still saying who authored it.
 */
function _fromEntity(doc) {
    const kind = doc.kind ?? kindForDoc(doc)
    return {
        id:        doc.id,
        source:    SOURCES.ENTITY,
        ready:     true,   // awaiting_confirm is by definition confirmable now
        asset:     doc.asset,
        assetClass: doc.asset_class ?? null,
        direction: doc.direction ?? null,
        action:    { type: 'entry', quantity: doc.quantity ?? null },
        // An entity awaiting confirmation is dismissed by the surface that owns it (the confirm
        // dialog parks it back to 'waiting'), never by the queue — a second way to drop the same
        // order is how two paths drift apart.
        cancellable: false,
        queuedBy:  'user',
        origin: {
            kind,
            entityId: doc.id,
            ref:      doc.portfolioId ?? doc.callId ?? null,
            // No stamped label: unlike a queued action, the entity is still here to be read from,
            // so the row names it live rather than from a snapshot taken hours ago.
            label:    doc.portfolioName ? `${doc.portfolioName}` : null,
        },
        decidedAt:  doc.pendingOrder?.builtAt ?? doc.entryTriggeredAt ?? null,
        nextOpenMs: null,
        queuedReason: null,
    }
}

/**
 * Everything waiting on one user, newest decision first.
 * Never throws — this feeds a notification count and a list; both degrade to "nothing" rather than
 * taking a monitor tick or a page render down with them.
 *
 * @param {string} userId
 * @param {{ readyOnly?: boolean }} [opts]  readyOnly drops items still waiting for their open
 * @returns {Promise<Array<object>>}
 */
export async function listWaiting(userId, { readyOnly = false } = {}) {
    if (!userId) return []
    try {
        const [queued, entities] = await Promise.all([
            listOpen(userId),
            entityRepo.listByOrderStates(userId, WAITING_ORDER_STATES),
        ])
        const rows = [...queued.map(_fromQueue), ...entities.map(_fromEntity)]
            .filter(r => (readyOnly ? r.ready : true))
        return rows.sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
    } catch (err) {
        logger.error(LOG, 'listWaiting failed', err.message)
        return []
    }
}

/** How many items are executable right now — the number Axl's card speaks. */
export async function countReady(userId) {
    return (await listWaiting(userId, { readyOnly: true })).length
}

export const pendingWorkService = { listWaiting, countReady, SOURCES, WAITING_ORDER_STATES }
