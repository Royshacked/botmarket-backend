// The off-hours queue — persistence for actions the user CONFIRMED but the market could not take.
//
// WHY ITS OWN RECORD, not a flag on the entity. `entity.orderState = 'awaiting_market'` already
// exists and looks like the same thing, but it means one specific thing: "this entity carries a
// pending ENTRY plan". A queued trim, exit or scale-in is not an entry, does not own an entity of
// its own, and can outlive the review that produced it — so it needs a record that can say WHAT
// was decided, ON WHAT, and WHERE it came from. Overloading orderState would also make one holding
// unable to hold two queued intents, which a review can legitimately produce.
//
// The record is the whole contract between the three parties that never meet: the desk that
// decided (a review, a monitor, a ticket), the sweep that releases at the open, and the list the
// user executes from. Everything the list needs to render a row is IN the record — including
// `origin.label`, stamped at enqueue, because by the time the market opens the review that
// produced it is closed and that context is gone.
//
// See docs/architecture/off-hours-queue.md (phase 1: record + registry + gate).

import { getDb, stripId } from '../../providers/mongodb.provider.js'
import { logger } from '../logger.service.js'
import { randomUUID } from 'crypto'

const LOG = '[pendingAction]'

/** Single source of truth for the collection name (mirrors entityCollection.js). */
export const PENDING_ACTIONS = 'pending_actions'

/**
 * The lifecycle. QUEUED → RELEASED happens on the market-open sweep (phase 2); RELEASED → DONE
 * when the user executes from the list (phase 3). CANCELLED is the user's, and is the only
 * transition that has to reach back into the origin (see originRegistry).
 */
export const STATES = Object.freeze({
    QUEUED:    'queued',
    RELEASED:  'released',
    // In flight at the broker. Its own state rather than a boolean: it is what makes a double-
    // clicked Execute safe (the second claim matches nothing), and it is deliberately NOT in
    // OPEN_STATES — an order already sent is not cancellable by forgetting about it.
    EXECUTING: 'executing',
    DONE:      'done',
    CANCELLED: 'cancelled',
    EXPIRED:   'expired',
})

/** The action verbs a queued item can carry. `entry` covers a new position or a full entry plan. */
export const ACTIONS = Object.freeze({
    ENTRY:  'entry',
    EXIT:   'exit',
    TRIM:   'trim',
    ADD_TO: 'add_to',
})

/** Terminal states never re-enter the queue — used by the dedupe and the sweep alike. */
const OPEN_STATES = [STATES.QUEUED, STATES.RELEASED]

export async function ensurePendingActionIndexes() {
    try {
        const db = await getDb()
        await db.collection(PENDING_ACTIONS).createIndexes([
            // The list read: one user's open items, newest decision first.
            { key: { userId: 1, state: 1, decidedAt: -1 } },
            // The sweep read: everything still queued, regardless of owner.
            { key: { state: 1, asset: 1 } },
            // The dedupe read (see enqueue) — accepting the same review twice must not double-queue.
            { key: { userId: 1, 'origin.entityId': 1, 'action.type': 1, state: 1 } },
        ])
    } catch (err) {
        logger.warn(LOG, 'ensurePendingActionIndexes failed', err.message)
    }
}

/**
 * Queue one decided-but-unexecutable action.
 *
 * IDEMPOTENT per (user, entity, verb) while the item is still open. A review accepted twice — a
 * double-click, a retry after a timeout — must not queue two trims of the same holding, because
 * each one would execute separately at the open and the second would trim a position the first
 * already shrank. The dedupe returns the EXISTING record rather than erroring: from the caller's
 * point of view "it is queued" is true either way, and that is all it acts on.
 *
 * @param {object}      p
 * @param {string}      p.userId
 * @param {string}      p.asset
 * @param {string|null} [p.assetClass]
 * @param {string|null} [p.direction]
 * @param {{ kind: string, desk?: string, entityId: string, ref?: string|null, label?: string|null }} p.origin
 * @param {{ type: string }} p.action        verb + its own params (fraction, qty, reason, plan…)
 * @param {string}      [p.queuedReason]     why it could not run now
 * @param {number|null} [p.nextOpenMs]       when the venue is expected to take it (display only)
 * @returns {Promise<{ ok: boolean, id?: string, record?: object, deduped?: boolean, reason?: string }>}
 */
export async function enqueue({
    userId, asset, assetClass = null, direction = null,
    origin, action, queuedReason = 'market_closed', nextOpenMs = null,
    queuedBy = 'user',
}) {
    if (!userId || !asset)          return { ok: false, reason: 'missing_target' }
    if (!origin?.kind || !origin?.entityId) return { ok: false, reason: 'missing_origin' }
    if (!action?.type)              return { ok: false, reason: 'missing_action' }

    try {
        const db = await getDb()

        const existing = await db.collection(PENDING_ACTIONS).findOne({
            userId:             String(userId),
            'origin.entityId':  String(origin.entityId),
            'action.type':      action.type,
            state:              { $in: OPEN_STATES },
        })
        if (existing) {
            logger.info(LOG, `already queued — ${action.type} on ${asset} (${existing.id})`)
            return { ok: true, id: existing.id, record: stripId(existing), deduped: true }
        }

        const record = {
            id:        randomUUID(),
            userId:    String(userId),
            state:     STATES.QUEUED,
            asset,
            assetClass,
            direction,
            origin: {
                kind:     origin.kind,
                desk:     origin.desk  ?? null,
                entityId: String(origin.entityId),
                ref:      origin.ref   ?? null,
                // Stamped now, deliberately: the row has to say where this came from at the open,
                // and the surface that knew is gone by then.
                label:    origin.label ?? null,
            },
            action,
            queuedReason,
            nextOpenMs,
            // WHO decided. 'user' — a discretionary choice (a review's trim), which they may
            // reasonably change their mind about. 'monitor' — the mechanical consequence of a plan
            // they already made (a stop that tripped overnight), which is NOT cancellable from the
            // list: dropping the row would just re-queue on the next tick while the stop is still
            // breached. You change a stop by moving it, not by dismissing its consequence.
            queuedBy,
            cancellable: queuedBy !== 'monitor',
            decidedAt:   Date.now(),
            releasedAt:  null,
            resolvedAt:  null,
        }
        await db.collection(PENDING_ACTIONS).insertOne(record)
        logger.info(LOG, `queued ${action.type} on ${asset} (${origin.kind}/${origin.entityId}) — ${queuedReason}`)
        return { ok: true, id: record.id, record: stripId(record) }
    } catch (err) {
        logger.error(LOG, 'enqueue failed', err.message)
        return { ok: false, reason: 'error' }
    }
}

/**
 * Every still-QUEUED action across all users — the market-open sweep's read.
 *
 * Deliberately not filtered by asset or clock here: the sweep asks `isAssetOpen` per row, because
 * one user's queue can hold a US equity, a future and a crypto name whose sessions open at three
 * different times. Released rows are excluded — they are already executable and have been counted.
 */
export async function listQueued() {
    try {
        const db = await getDb()
        const rows = await db.collection(PENDING_ACTIONS)
            .find({ state: STATES.QUEUED })
            .sort({ decidedAt: 1 })
            .toArray()
        return rows.map(stripId)
    } catch (err) {
        logger.error(LOG, 'listQueued failed', err.message)
        return []
    }
}

/** One user's open queue, newest decision first. Phase 3's list reads this. */
export async function listOpen(userId) {
    try {
        const db = await getDb()
        const rows = await db.collection(PENDING_ACTIONS)
            .find({ userId: String(userId), state: { $in: OPEN_STATES } })
            .sort({ decidedAt: -1 })
            .toArray()
        return rows.map(stripId)
    } catch (err) {
        logger.error(LOG, 'listOpen failed', err.message)
        return []
    }
}

export async function getById(id, userId) {
    try {
        const db  = await getDb()
        const row = await db.collection(PENDING_ACTIONS).findOne({ id: String(id), userId: String(userId) })
        return row ? stripId(row) : null
    } catch (err) {
        logger.error(LOG, 'getById failed', err.message)
        return null
    }
}

/**
 * Move an item to a new state, but ONLY from an expected one.
 *
 * Conditional by design — the same claim shape the market-open sweep uses on entities. Transitions
 * race: the sweep releases while the user cancels, two ticks read the same queued row, two tabs
 * both press Execute. The loser must find the transition already taken rather than overwrite it.
 *
 * `from` MATTERS, and defaulting it to "any open state" is a bug rather than a convenience: the
 * sweep's release would then succeed against an ALREADY-RELEASED row, so two overlapping ticks
 * would each believe they woke it and each post a market-open card. Callers that genuinely mean
 * "from wherever it is now" pass OPEN_STATES explicitly.
 *
 * @param {string|string[]} [from]  the state(s) the caller expects to move it out of
 * @returns {Promise<boolean>} true if THIS caller made the transition
 */
export async function transition(id, userId, toState, patch = {}, { from = OPEN_STATES } = {}) {
    // An undefined target would write `state: undefined` — a row that is neither open nor terminal,
    // so it can never be run, cancelled or swept again. Caught here because a typo'd STATES key is
    // silent everywhere else (it reads as "use the default `from`", which succeeds).
    if (!toState) {
        logger.error(LOG, `refusing a transition to an undefined state (${id}) — check the STATES key`)
        return false
    }
    try {
        const db  = await getDb()
        const res = await db.collection(PENDING_ACTIONS).updateOne(
            transitionFilter(id, userId, from),
            { $set: { state: toState, ...patch } },
        )
        return res.modifiedCount === 1
    } catch (err) {
        logger.error(LOG, 'transition failed', err.message)
        return false
    }
}

/**
 * The guard itself, pure — this is the whole correctness of a transition, so it is testable without
 * a Mongo behind it. Ownership is part of the filter, not a separate check: a lookup-then-write
 * would leave a window where another request moves the row between the two.
 */
export function transitionFilter(id, userId, from = OPEN_STATES) {
    return {
        id:     String(id),
        userId: String(userId),
        state:  { $in: Array.isArray(from) ? from : [from] },
    }
}

export const pendingActionRepo = {
    ensurePendingActionIndexes, enqueue, listQueued, listOpen, getById, transition,
    PENDING_ACTIONS, STATES, ACTIONS,
}
