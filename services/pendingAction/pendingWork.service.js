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
import { resolveMode } from '../venue.resolve.service.js'
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
function _fromQueue(rec, mode = null) {
    return {
        id:        rec.id,
        source:    SOURCES.QUEUE,
        ready:     rec.state === STATES.RELEASED,
        // The workspace this action belongs to — resolved from the origin entity at read time, not
        // stored on the record (see listWaiting). A queued row is about an account-bound entity,
        // and a list that cannot say which book a row is in is two books shown as one.
        mode,
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
        mode:      resolveMode(doc),
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
 *
 * Never throws BY DEFAULT — this feeds a notification count and a list; both degrade to "nothing"
 * rather than taking a monitor tick or a page render down with them. `onError: 'throw'` is for the
 * one reader that must not mistake a failed read for an empty queue: Axl's watchlist, whose
 * contract is that a source it could not read is NAMED, never reported as zero.
 *
 * A queued record stores no venue (the surface that knew is gone by the open), so the origin
 * entities are read in one batch and each row is stamped with the mode resolved from its own — the
 * same `resolveMode` every list applies. An origin that no longer exists leaves `mode: null`.
 *
 * @param {string} userId
 * @param {{ readyOnly?: boolean }} [opts]  readyOnly drops items still waiting for their open
 * @returns {Promise<Array<object>>}
 */
export async function listWaiting(userId, { readyOnly = false, onError = null } = {}, deps = {}) {
    if (!userId) return []
    const {
        open = listOpen,
        awaiting = (uid) => entityRepo.listByOrderStates(uid, WAITING_ORDER_STATES),
        origins = (ids) => entityRepo.listByIds(ids, { id: 1, broker: 1, accountId: 1, mainAccountId: 1, mode: 1 }),
    } = deps
    try {
        const [queued, entities] = await Promise.all([open(userId), awaiting(userId)])
        const originIds = [...new Set(queued.map(r => r.origin?.entityId).filter(Boolean))]
        const originDocs = originIds.length ? await origins(originIds) : []
        const modeOf = new Map(originDocs.map(d => [String(d.id), resolveMode(d)]))
        const rows = [
            ...queued.map(r => _fromQueue(r, modeOf.get(String(r.origin?.entityId)) ?? null)),
            ...entities.map(_fromEntity),
        ].filter(r => (readyOnly ? r.ready : true))
        return rows.sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
    } catch (err) {
        if (onError === 'throw') throw err
        logger.error(LOG, 'listWaiting failed', err.message)
        return []
    }
}

/** How many items are executable right now — the number Axl's card speaks. */
export async function countReady(userId) {
    return (await listWaiting(userId, { readyOnly: true })).length
}

// NO SERVICE-OBJECT AGGREGATE HERE, deliberately. One stood at this line and nothing outside the
// file ever referenced it — every caller imports the named functions directly, which is what the
// rest of pendingAction/ and monitoring/ already do. §1 deleted paperExecutionService and
// manualExecutionService for the same reason: an aggregate that exists only to be exported is a
// second public surface to keep in step with the first.
