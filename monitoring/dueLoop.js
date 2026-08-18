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
// What each monitor still owns: which documents are its own, and the check itself.
//
// IT IS NOT ONLY FOR THE ENTITY COLLECTION. Coverage (Prometheus) and tilt (Pythia) each carried the
// same hand-rolled due-selection over their OWN collection, keyed on `monitor.next_check_at` rather
// than `monitor_state.next_check_at`, with no lease at all. Three parameters — `statePath`, an
// optional `kind`, and `limit` — were the whole distance between those copies and this one, so the
// last two hand-rolled selections ride here now and inherit the claim for free.

import { getDb } from '../providers/mongodb.provider.js'
import { logger } from '../services/logger.service.js'
import { withTimeout } from '../services/timeout.util.js'
import { createPollLoop } from './pollLoop.js'
import { withJournal } from './monitorJournal.js'

/**
 * Build a monitor's poll loop.
 *
 * @param {object}   spec
 * @param {string}   spec.collection     physical collection name
 * @param {string}   [spec.kind]         the entity kind this monitor owns — the filter that keeps
 *                                       two monitors from ever contending for the same document.
 *                                       OMIT IT for a collection that holds one thing (coverage,
 *                                       tilt): those documents carry no `kind`, and querying for
 *                                       one would select nothing — silently, and forever.
 * @param {string[]} [spec.statuses]     statuses to poll, as an allow-list. Omit when the rule is
 *                                       not a list — coverage's is "anything but retired" — and put
 *                                       it in `filter` instead.
 * @param {string}   [spec.statePath]    the subdocument holding `next_check_at`: 'monitor_state' on
 *                                       entities, 'monitor' on coverage and tilt.
 * @param {object}   [spec.filter]       extra query clauses (e.g. Talos's `broker: {$ne: null}`)
 * @param {number}   [spec.limit]        cap the documents claimed per tick (0 = no cap). The
 *                                       overflow stays due and lands on a later tick.
 * @param {Function} spec.check          async (entity, nowMs) => any — the monitor's own brain. A
 *                                       returned value is collected for `afterTick`.
 * @param {Function} [spec.afterTick]    async (results) => void, once per tick after every check,
 *                                       given `[{entity, result}]` for the checks that returned one.
 *                                       For a decision no single check can make — coverage spends a
 *                                       per-tick re-model budget across the whole due set.
 * @param {number}   spec.intervalMs     how often to look for due work
 * @param {number}   spec.checkTimeoutMs bound on ONE check, so a hung read can't wedge the loop
 * @param {boolean}  [spec.eager]        run a tick at start(). False for the hourly research loops,
 *                                       which have no reason to fire on every deploy.
 * @param {string}   spec.log            log prefix
 * @param {string}   spec.name           human name for the log lines
 * @param {Function} [spec.getDbFn]      TEST SEAM. The claim is the subtle part and the one worth
 *                                       asserting, and it is unreachable behind a module-level
 *                                       `getDb()` — which in a test process opens a real pool.
 * @returns {{ start: Function, stop: Function, _tick: Function, _claim: Function }}
 */
export function createDueLoop({
    collection, kind = null, statuses = null, statePath = 'monitor_state',
    filter = {}, limit = 0, check, afterTick = null,
    intervalMs = 60_000, checkTimeoutMs = 90_000, eager = true, log = '[dueLoop]', name = 'monitor',
    getDbFn = getDb,
}) {
    // The lease horizon must be >= the check timeout, or an abandoned check could be re-selected
    // while it is still running — the exact double-fire this exists to prevent.
    const leaseMs = checkTimeoutMs

    // The one field this whole module turns on, named once. `{field: null}` also matches a document
    // where it is ABSENT — Mongo treats missing as null — so a never-checked document is due without
    // needing an `$exists` clause of its own.
    const NEXT  = `${statePath}.next_check_at`
    const dueAt = (nowIso) => [{ [NEXT]: null }, { [NEXT]: { $lte: nowIso } }]
    // Built once: the clauses that say "these documents are mine", whatever names them.
    const scope = {
        ...(kind     ? { kind }                      : {}),
        ...(statuses ? { status: { $in: statuses } } : {}),
        ...filter,
    }

    async function _claim(entity, nowMs) {
        const db = await getDbFn()
        const res = await db.collection(collection).updateOne(
            {
                id: entity.id,
                // Pinning the status too: an entity whose lifecycle moved between the read and the
                // claim is no longer the thing we decided to check. Conditional, because a document
                // that has no status must not be matched on `undefined` — the driver sends that as
                // null, which would claim a different document than the one we read.
                ...(entity.status !== undefined ? { status: entity.status } : {}),
                $or: dueAt(new Date(nowMs).toISOString()),
            },
            { $set: { [NEXT]: new Date(nowMs + leaseMs).toISOString() } },
        )
        return res.modifiedCount === 1
    }

    async function _tick() {
        let due
        try {
            const db  = await getDbFn()
            const now = new Date().toISOString()
            // Due = in scope AND (never checked OR next_check_at has passed). Same-format UTC ISO
            // strings compare lexicographically, so $lte on the string is correct.
            let cursor = db.collection(collection).find({ ...scope, $or: dueAt(now) })
            if (limit > 0) cursor = cursor.limit(limit)
            due = await cursor.toArray()
        } catch (err) {
            logger.error(log, 'DB read error in tick:', err.message)
            return
        }

        if (!due.length) return
        logger.info(log, `checking ${due.length} due ${kind ?? 'document'}(s)`)

        const results = []
        for (const entity of due) {
            if (!(await _claim(entity, Date.now()))) {
                logger.info(log, `${entity.id} already claimed — skipping`)
                continue
            }
            // One bad entity must never stop the others, and must never wedge the loop.
            try {
                const result = await withTimeout(check(entity, Date.now()), checkTimeoutMs)
                if (result !== undefined) results.push({ entity, result })
            }
            catch (err) { logger.error(log, `check failed for ${entity.id}:`, err.message) }
        }

        // After every check, never in place of one: a tick-wide budget can only be spent once the
        // whole due set has said what it wants. Its failure is logged and dropped — every check has
        // already persisted its own work, and losing that to a bad afterTick would be the worse bug.
        if (afterTick && results.length) {
            try { await afterTick(results) }
            catch (err) { logger.error(log, 'afterTick failed:', err.message) }
        }
    }

    const loop = createPollLoop({ intervalMs, tick: _tick, eager, log, name })
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
