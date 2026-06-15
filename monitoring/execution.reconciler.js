/**
 * Execution reconciler — turns normalized broker execution events into idea-status
 * updates. Broker-agnostic: it listens to the single executionBus and never knows
 * which broker produced an event (see project memory "one real-time channel").
 *
 * What it does:
 *   • position.closed            → idea status → 'closed' (+ reason / pnl / closedAt),
 *                                  idempotent (only flips ideas still long/short).
 *   • position.opened / filled   → backfill the broker positionId onto the idea's
 *                                  brokerOrders linkage, so a later close can match.
 *
 * Linkage lives on the idea as `brokerOrders: [{ broker, accountId, orderId,
 * positionId }]`, written by placeOrdersForIdea. Matching is on accountId +
 * positionId (globally unique per broker account).
 *
 * Reversibility: remove `executionReconciler.start()` from server.js. It only ever
 * patches ideas the broker has already acted on, never places orders.
 */

import { getDb }        from '../providers/mongodb.provider.js'
import { logger }       from '../services/logger.service.js'
import { executionBus } from '../services/executionBus.js'
import { brokerService } from '../api/broker/broker.service.js'

const LOG        = '[execution.reconciler]'
const COLLECTION = 'ideas'
const ACTIVE     = ['long', 'short']

let _started = false

export const executionReconciler = { start, handleExecution }

function start() {
    if (_started) return
    _started = true
    executionBus.on('execution', handleExecution)
    logger.info(LOG, 'Execution reconciler listening on executionBus')
    // Resume feeds for positions opened in a previous run (best-effort, async).
    _resumeFeeds().catch(err => logger.error(LOG, 'resumeFeeds error:', err.message))
}

// ─── Event handling ─────────────────────────────────────────────────────────────

/**
 * @param {import('../api/broker/adapters/broker.interface.js').BrokerExecution} exec
 */
async function handleExecution(exec) {
    try {
        switch (exec?.type) {
            case 'position.closed':                       return _onClosed(exec)
            case 'position.opened':
            case 'order.filled':                          return _onOpened(exec)
            default:                                      return   // accepted/rejected/cancelled — nothing to reconcile yet
        }
    } catch (err) {
        logger.error(LOG, `handleExecution error (${exec?.type}):`, err.message)
    }
}

async function _onClosed(exec) {
    if (exec.positionId == null) return
    const db = await getDb()
    const patch = {
        status:       'closed',
        closedReason: exec.reason ?? 'broker',
        closedAt:     exec.at ?? Date.now(),
    }
    if (exec.pnl != null) patch.realizedPnl = exec.pnl

    const result = await db.collection(COLLECTION).findOneAndUpdate(
        {
            status: { $in: ACTIVE },
            brokerOrders: { $elemMatch: { accountId: String(exec.accountId), positionId: String(exec.positionId) } },
        },
        { $set: patch },
        { returnDocument: 'after' },
    )
    if (result) {
        logger.info(LOG, `Idea ${result.id} closed by broker (reason=${patch.closedReason}, pnl=${patch.realizedPnl ?? '·'})`)
    } else {
        logger.info(LOG, `No active idea matched closed position ${exec.accountId}/${exec.positionId}`)
    }
}

async function _onOpened(exec) {
    if (exec.positionId == null) return
    const db = await getDb()

    // Already linked? Then this is just a duplicate/again — nothing to backfill.
    const linked = await db.collection(COLLECTION).findOne(
        { brokerOrders: { $elemMatch: { accountId: String(exec.accountId), positionId: String(exec.positionId) } } },
        { projection: { id: 1 } },
    )
    if (linked) return

    // Find an active idea on this account+symbol with an unlinked order slot and
    // stamp the positionId onto it (positional $ + arrayFilters target one element).
    const filter = {
        status: { $in: ACTIVE },
        brokerOrders: { $elemMatch: { accountId: String(exec.accountId), positionId: null } },
    }
    if (exec.symbol) filter.asset = exec.symbol

    const result = await db.collection(COLLECTION).findOneAndUpdate(
        filter,
        { $set: { 'brokerOrders.$[slot].positionId': String(exec.positionId) } },
        {
            arrayFilters:   [{ 'slot.accountId': String(exec.accountId), 'slot.positionId': null }],
            returnDocument: 'after',
        },
    )
    if (result) logger.info(LOG, `Backfilled positionId ${exec.positionId} onto idea ${result.id}`)
}

// ─── Resume feeds after a restart ─────────────────────────────────────────────

async function _resumeFeeds() {
    const db = await getDb()
    const ideas = await db.collection(COLLECTION)
        .find(
            { status: { $in: ACTIVE }, brokerOrders: { $exists: true, $ne: [] } },
            { projection: { userId: 1, brokerOrders: 1 } },
        )
        .toArray()

    // Distinct (broker, userId, accountId) so we open each account feed once.
    const seen = new Set()
    let count  = 0
    for (const idea of ideas) {
        for (const link of idea.brokerOrders ?? []) {
            const key = `${link.broker}:${idea.userId}:${link.accountId}`
            if (seen.has(key) || !idea.userId || !link.broker || !link.accountId) continue
            seen.add(key)
            try {
                const ok = await brokerService.startExecutionFeed(link.broker, idea.userId, link.accountId)
                if (ok) count++
            } catch (err) {
                logger.warn(LOG, `resume feed failed (${key}):`, err.message)
            }
        }
    }
    if (count > 0) logger.info(LOG, `Resumed ${count} execution feed(s) for active positions`)
}
