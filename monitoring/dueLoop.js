// The wake-up chore: find what's due, claim it so nothing checks it twice, check it, don't wedge.
//
// This is the other half of the duplication readinessGates.js names (and the larger half by line
// count). Hermes and Talos each carried a private copy of the same forty lines, differing only in
// which kind and statuses they select.
//
// THE CLAIM IS THE SUBTLE PART, and the reason this is worth having in one place. `withTimeout`
// ABANDONS a slow check but cannot CANCEL it — the promise keeps running. Without a lease, the next
// tick re-selects an entity whose check is still in flight and processes it a SECOND time,
// concurrently, which is how a monitor double-fires an entry card. The lease pushes `next_check_at`
// a full check-timeout forward BEFORE the check starts, conditional on the entity still being due
// so a fresher schedule is never clobbered, and the check's own write then overwrites the lease
// with the real cadence. Getting that wrong duplicates orders; it should be written once.
//
// What each monitor still owns: which kind, which statuses, any extra filter, and the check itself.

import { getDb } from '../providers/mongodb.provider.js'
import { logger } from '../services/logger.service.js'
import { withTimeout } from '../services/timeout.util.js'
import { createPollLoop } from './monitorUtils.js'
import { withJournal } from './monitorJournal.js'

/**
 * Build a monitor's poll loop.
 *
 * @param {object}   spec
 * @param {string}   spec.collection     physical collection name
 * @param {string}   spec.kind           the entity kind this monitor owns — the filter that keeps
 *                                       two monitors from ever contending for the same document
 * @param {string[]} spec.statuses       statuses to poll
 * @param {object}   [spec.filter]       extra query clauses (e.g. Talos's `broker: {$ne: null}`)
 * @param {Function} spec.check          async (entity, nowMs) => void — the monitor's own brain
 * @param {number}   spec.intervalMs     how often to look for due work
 * @param {number}   spec.checkTimeoutMs bound on ONE check, so a hung read can't wedge the loop
 * @param {string}   spec.log            log prefix
 * @param {string}   spec.name           human name for the log lines
 * @returns {{ start: Function, stop: Function, _tick: Function }}
 */
export function createDueLoop({
    collection, kind, statuses, filter = {}, check,
    intervalMs = 60_000, checkTimeoutMs = 90_000, log = '[dueLoop]', name = 'monitor',
}) {
    // The lease horizon must be >= the check timeout, or an abandoned check could be re-selected
    // while it is still running — the exact double-fire this exists to prevent.
    const leaseMs = checkTimeoutMs

    async function _claim(entity, nowMs) {
        const db = await getDb()
        const res = await db.collection(collection).updateOne(
            {
                id: entity.id,
                // Pinning the status too: an entity whose lifecycle moved between the read and the
                // claim is no longer the thing we decided to check.
                status: entity.status,
                $or: [
                    { 'monitor_state.next_check_at': null },
                    { 'monitor_state.next_check_at': { $lte: new Date(nowMs).toISOString() } },
                ],
            },
            { $set: { 'monitor_state.next_check_at': new Date(nowMs + leaseMs).toISOString() } },
        )
        return res.modifiedCount === 1
    }

    async function _tick() {
        let due
        try {
            const db  = await getDb()
            const now = new Date().toISOString()
            // Due = a polled status AND (never checked OR next_check_at has passed). Same-format UTC
            // ISO strings compare lexicographically, so $lte on the string is correct.
            due = await db.collection(collection).find({
                kind,
                status: { $in: statuses },
                ...filter,
                $or: [
                    { 'monitor_state.next_check_at': null },
                    { 'monitor_state.next_check_at': { $lte: now } },
                ],
            }).toArray()
        } catch (err) {
            logger.error(log, 'DB read error in tick:', err.message)
            return
        }

        if (!due.length) return
        logger.info(log, `checking ${due.length} due ${kind}(s)`)

        for (const entity of due) {
            if (!(await _claim(entity, Date.now()))) {
                logger.info(log, `${entity.id} already claimed — skipping`)
                continue
            }
            // One bad entity must never stop the others, and must never wedge the loop.
            try { await withTimeout(check(entity, Date.now()), checkTimeoutMs) }
            catch (err) { logger.error(log, `check failed for ${entity.id}:`, err.message) }
        }
    }

    const loop = createPollLoop({ intervalMs, tick: _tick, eager: true, log, name })
    return { start: loop.start, stop: loop.stop, _tick, _claim }
}

/**
 * The write every wake ends with: the monitor's `$set`, plus the journal line appended and capped.
 *
 * It RETHROWS. Swallowing made a failed write invisible twice over — the wake reported success, and
 * the code carried on to fire a card describing state that was never saved. The per-entity catch in
 * the tick logs it and moves on, so one bad write still can't stop the loop.
 */
export function makePersist({ collection, kind = null, timelineMax, log }) {
    // `kind` is OPTIONAL and only Talos passes it. Adding it to Hermes's filter would be a
    // behaviour change, not an extraction: a pre-P3b call document that predates the field would
    // stop matching and silently never persist again.
    const match = kind ? (id) => ({ id, kind }) : (id) => ({ id })
    // `db` is an OPTIONAL last argument, not a hidden dependency: Hermes threads a connection
    // through every call site and its tests inject a fake one there, which is the only reason 131
    // DB-less tests can exercise the write path at all. Resolving getDb() unconditionally here
    // would have quietly taken that away.
    return async function persist(id, $set, logEntry = null, db = null) {
        try {
            const conn = db ?? await getDb()
            await conn.collection(collection).updateOne(match(id), withJournal($set, logEntry, timelineMax))
        } catch (err) {
            logger.error(log, `persist failed for ${id}:`, err.message)
            throw err
        }
    }
}
