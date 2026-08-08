// The queued list's HTTP tier — read, execute, cancel.
//
// One read (`listWaiting`) unions the two stores, so the client never has to know a row's
// provenance except to act on it. The two writes only ever touch QUEUE rows: an entity awaiting
// confirmation is executed by the order-confirm path it already had, and dismissed by the event it
// already had. Adding a second way to place the same order is how two paths drift.
//
// See docs/architecture/off-hours-queue.md.

import { logger } from '../../services/logger.service.js'
import { listWaiting } from '../../services/pendingAction/pendingWork.service.js'
import { getById, transition, STATES } from '../../services/pendingAction/pendingAction.repo.js'
import { cancelOrigin, executeOrigin } from '../../services/pendingAction/originRegistry.js'

const LOG = '[pendingAction]'

/**
 * GET /api/pending-actions?ready=1
 * `ready=1` drops items whose venue has not opened yet — what the card counts. Without it the list
 * shows the lot, because "waiting, but not until Monday" is information the user wants, and hiding
 * it is how a decision gets forgotten.
 */
export async function getPendingActions(req, res) {
    try {
        const readyOnly = req.query?.ready === '1' || req.query?.ready === 'true'
        const items = await listWaiting(req.user._id, { readyOnly })
        res.json({ items, count: items.length })
    } catch (err) {
        logger.error(LOG, 'getPendingActions failed', err)
        res.status(500).json({ error: 'Failed to read the queue' })
    }
}

/**
 * POST /api/pending-actions/:id/execute — run a released action for real.
 *
 * CLAIM FIRST. The row moves to `executing` before the broker is touched, guarded on RELEASED, so
 * a double-click or two open tabs cannot place the same trim twice: the second caller finds the
 * transition already taken and is told so. On failure it goes BACK to released — a refusal is not
 * a reason to lose the decision, and the user may well fix the cause and retry.
 */
export async function executePendingAction(req, res) {
    const { id } = req.params
    try {
        const record = await getById(id, req.user._id)
        if (!record) return res.status(404).json({ error: 'Not found' })
        if (record.state !== STATES.RELEASED) {
            // Still queued = its venue has not opened. Not an error the user did anything wrong,
            // so it answers with the state rather than a bare failure.
            return res.status(409).json({ error: 'not_ready', state: record.state, nextOpenMs: record.nextOpenMs ?? null })
        }

        if (!await transition(id, req.user._id, STATES.EXECUTING, {}, { from: STATES.RELEASED })) {
            return res.status(409).json({ error: 'already_running' })
        }

        const result = await executeOrigin(record)

        if (result?.deferred) {
            // The venue shut again between the sweep and the click (an after-hours visit). The gate
            // re-queued onto this same row via the enqueue dedupe, so put it back where it was.
            await transition(id, req.user._id, STATES.QUEUED, {}, { from: STATES.EXECUTING })
            return res.status(409).json({ error: 'market_closed', nextOpenMs: result.nextOpenMs ?? null })
        }
        if (!result?.ok) {
            await transition(id, req.user._id, STATES.RELEASED, {}, { from: STATES.EXECUTING })
            return res.status(400).json({ error: result?.reason ?? 'failed' })
        }

        await transition(id, req.user._id, STATES.DONE, { resolvedAt: Date.now() }, { from: STATES.EXECUTING })
        logger.info(LOG, `executed ${record.action?.type} on ${record.asset} (${id})`)
        res.json({ ok: true, result })
    } catch (err) {
        logger.error(LOG, `executePendingAction failed (${id})`, err)
        // Best-effort unwind: leaving a row stuck in `executing` would make it un-runnable and
        // un-cancellable, which is worse than a retryable failure.
        try { await transition(id, req.user._id, STATES.RELEASED, {}, { from: STATES.EXECUTING }) } catch { /* already moved */ }
        res.status(500).json({ error: 'Failed to execute' })
    }
}

/**
 * POST /api/pending-actions/:id/cancel — drop a queued action and tell the desk that decided it.
 *
 * The transition comes FIRST and the notification second: the user's cancellation is the fact, and
 * an origin that could not be notified must not resurrect a decision they already dropped. A failed
 * notification is logged and reported as `noted:false` rather than failing the request.
 */
export async function cancelPendingAction(req, res) {
    const { id } = req.params
    try {
        const record = await getById(id, req.user._id)
        if (!record) return res.status(404).json({ error: 'Not found' })

        if (!await transition(id, req.user._id, STATES.CANCELLED, { resolvedAt: Date.now() })) {
            // Terminal already, or mid-execution — either way it is not the caller's to cancel.
            return res.status(409).json({ error: 'not_cancellable', state: record.state })
        }

        const noted = await cancelOrigin(record)
        logger.info(LOG, `cancelled ${record.action?.type} on ${record.asset} (${id}) — desk notified: ${noted.ok}`)
        res.json({ ok: true, noted: noted.ok === true })
    } catch (err) {
        logger.error(LOG, `cancelPendingAction failed (${id})`, err)
        res.status(500).json({ error: 'Failed to cancel' })
    }
}
