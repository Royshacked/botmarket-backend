/**
 * Execution reconciler — turns normalized broker execution events into idea-status
 * updates AND owns the lifecycle of an idea's native exit orders. Broker-agnostic:
 * it listens to the single executionBus and never knows which broker produced an
 * event (see project memory "one real-time channel").
 *
 * What it does:
 *   • position.opened / filled   → backfill the broker positionId onto the idea's
 *                                  brokerOrders linkage, then PLACE that account's
 *                                  native exit orders (multi-level bare-price stops/
 *                                  TPs: LIMIT for tp, STOP for stop), once per account.
 *   • position.reduced (partial) → a single exit slice filled. Mark it filled and
 *                                  re-sync the remaining working exit orders so none
 *                                  exceeds the shrunken position (netting safety).
 *   • position.closed (full)     → idea status → 'closed' (+ reason / pnl / closedAt),
 *                                  then cancel any leftover working exit orders so a
 *                                  resting opposite order can't open a new position.
 *
 * Linkage lives on the idea as `brokerOrders: [{ broker, accountId, orderId,
 * positionId, quantity }]` (entry orders) and `exitOrders: [{ accountId, broker,
 * leg, type, price, quantity, orderId, status }]` (exit orders). Matching is on
 * accountId + positionId (closes) or accountId + orderId (exit-slice fills).
 *
 * Remaining position size (idea units) is DERIVED, not stored: entry quantity for
 * the account minus the sum of its filled exit slices. v1 assumptions: exit orders
 * fill in full (a rare single-order partial fill over-counts conservatively), and
 * a partial close that doesn't match a tracked exit order (e.g. a manual close from
 * the broker UI) can't be sized in idea units, so it's logged and skipped.
 *
 * Reversibility: remove `executionReconciler.start()` from server.js.
 */

import { getDb }         from '../providers/mongodb.provider.js'
import { logger }        from '../services/logger.service.js'
import { executionBus }  from '../services/executionBus.js'
import { brokerService } from '../api/broker/broker.service.js'

const LOG        = '[execution.reconciler]'
const COLLECTION = 'ideas'
const ACTIVE     = ['long', 'short']
const EPS        = 1e-6   // quantity comparison slack

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
    // Await each handler INSIDE the try so a rejection is always caught here. The
    // executionBus is an EventEmitter — it ignores the promise this returns, so an
    // un-awaited rejection would become an unhandledRejection and crash the process.
    try {
        switch (exec?.type) {
            case 'position.closed':                       await _onClosed(exec);  break
            case 'position.reduced':                      await _onReduced(exec); break
            case 'position.opened':
            case 'order.filled':                          await _onOpened(exec);  break
            default:                                      break   // accepted/rejected/cancelled — nothing to reconcile yet
        }
    } catch (err) {
        logger.error(LOG, `handleExecution error (${exec?.type}):`, err.message)
    }
}

async function _onClosed(exec) {
    if (exec.positionId == null) return
    await _withLock(exec.accountId, exec.positionId, async () => {
        const db   = await getDb()
        const idea = await db.collection(COLLECTION).findOne({
            status: { $in: ACTIVE },
            brokerOrders: { $elemMatch: { accountId: String(exec.accountId), positionId: String(exec.positionId) } },
        })
        if (!idea) {
            logger.info(LOG, `No active idea matched closed position ${exec.accountId}/${exec.positionId}`)
            return
        }

        // Attribute the close: a matched exit order's leg is the reason (native LIMIT
        // ⇒ tp / STOP ⇒ stop, or a monitor market close); else a monitor full-close
        // stamped pendingCloseReason; else whatever the broker reported.
        const matched = (idea.exitOrders ?? []).find(o => exec.orderId != null && String(o.orderId) === String(exec.orderId))
        const reason  = matched?.leg ?? idea.pendingCloseReason ?? exec.reason ?? 'broker'

        const patch = { status: 'closed', closedReason: reason, closedAt: exec.at ?? Date.now() }
        if (exec.pnl != null) patch.realizedPnl = exec.pnl

        const result = await db.collection(COLLECTION).findOneAndUpdate(
            { id: idea.id, status: { $in: ACTIVE } },
            { $set: patch },
            { returnDocument: 'after' },
        )
        if (!result) return   // someone else closed it first
        logger.info(LOG, `Idea ${result.id} closed by broker (reason=${reason}, pnl=${patch.realizedPnl ?? '·'})`)

        // Cancel any leftover working exit orders for this account: on a netting
        // account a resting opposite-side order would otherwise OPEN a new position.
        await _cancelWorkingExits(db, result, exec.accountId)
    })
}

async function _onReduced(exec) {
    if (exec.positionId == null) return
    await _withLock(exec.accountId, exec.positionId, async () => {
        const db   = await getDb()
        const idea = await db.collection(COLLECTION).findOne({
            status: { $in: ACTIVE },
            brokerOrders: { $elemMatch: { accountId: String(exec.accountId), positionId: String(exec.positionId) } },
        })
        if (!idea) return

        // Match the closing order to one of our tracked exit orders (a native resting
        // order, or a market close the monitor placed). An unmatched reduction can't
        // be sized in idea units — log and skip rather than mis-resync.
        const orders = idea.exitOrders ?? []
        const idx = orders.findIndex(o =>
            o.status === 'working' &&
            String(o.accountId) === String(exec.accountId) &&
            exec.orderId != null && String(o.orderId) === String(exec.orderId))
        if (idx < 0) {
            logger.info(LOG, `Idea ${idea.id}: partial close on ${exec.accountId}/${exec.positionId} didn't match a tracked exit order — skipping resync`)
            return
        }

        orders[idx] = { ...orders[idx], status: 'filled', filledAt: exec.at ?? Date.now() }
        await db.collection(COLLECTION).updateOne({ id: idea.id }, { $set: { exitOrders: orders } })
        logger.info(LOG, `Idea ${idea.id}: exit slice filled — ${orders[idx].leg} ${orders[idx].quantity} @ ${orders[idx].price ?? 'mkt'}`)

        await _resyncExits(db, { ...idea, exitOrders: orders }, exec.accountId)
    })
}

async function _onOpened(exec) {
    if (exec.positionId == null) return
    const db = await getDb()

    // Resting entry filled: a broker-native stop-market entry the idea was holding
    // as a working order (status 'resting', orderId linked, positionId not yet set).
    // The fill opens the position — flip the idea live and stamp the positionId so a
    // later close reconciles. Matched on accountId + orderId (the resting linkage).
    if (exec.orderId != null) {
        const direction = exec.direction === 'short' ? 'short' : 'long'
        const resting = await db.collection(COLLECTION).findOneAndUpdate(
            {
                status: 'resting',
                brokerOrders: { $elemMatch: { accountId: String(exec.accountId), orderId: String(exec.orderId) } },
            },
            {
                $set: {
                    status:         direction,
                    orderState:     'placed',
                    ordersPlacedAt: exec.at ?? Date.now(),
                    activatedAt:    exec.at ?? Date.now(),
                    'brokerOrders.$[slot].positionId': String(exec.positionId),
                },
            },
            {
                arrayFilters:   [{ 'slot.accountId': String(exec.accountId), 'slot.orderId': String(exec.orderId) }],
                returnDocument: 'after',
            },
        )
        if (resting) {
            logger.info(LOG, `Resting entry filled → idea ${resting.id} now ${direction} (position ${exec.positionId})`)
            await _withLock(exec.accountId, exec.positionId, () => _placeExits(db, resting, exec.accountId))
            return
        }
    }

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
    if (!result) return
    logger.info(LOG, `Backfilled positionId ${exec.positionId} onto idea ${result.id}`)

    // Position is open — place this account's native exit orders (once).
    await _withLock(exec.accountId, exec.positionId, () => _placeExits(db, result, exec.accountId))
}

// ─── Native exit orders ───────────────────────────────────────────────────────

/**
 * Place an account's native exit orders when its position opens — one broker order
 * per multi-level bare-price level (LIMIT for tp, STOP for stop, opposite side),
 * scaled from the idea-unit plan to this account's filled quantity. Idempotent per
 * account via `exitPlacedAccounts`.
 */
async function _placeExits(db, idea, accountId) {
    try {
        const acct = String(accountId)
        if ((idea.exitPlacedAccounts ?? []).map(String).includes(acct)) return   // already placed

        const native     = idea.nativeExit
        const slot       = (idea.brokerOrders ?? []).find(b => String(b.accountId) === acct)
        const entryQty   = Number(slot?.quantity) || 0
        const totalQty   = Number(idea.quantity)  || 0
        const factor     = (entryQty > 0 && totalQty > 0) ? entryQty / totalQty : 1
        const positionId = slot?.positionId ?? null   // makes each exit a CLOSING order

        const newOrders = []
        if (native && entryQty > 0) {
            for (const leg of ['stop', 'tp']) {
                for (const lvl of native[leg] ?? []) {
                    const qty = _round(Number(lvl.quantity) * factor)
                    if (!(qty > 0)) continue
                    try {
                        const placed = await _placeOneExit(idea, acct, slot?.broker, leg, lvl.level, qty, positionId)
                        newOrders.push({
                            accountId: acct, broker: slot?.broker, leg,
                            type: leg === 'tp' ? 'limit' : 'stop',
                            price: lvl.level, quantity: qty, positionId,
                            orderId: placed.orderId, status: 'working', placedAt: Date.now(),
                        })
                        logger.info(LOG, `Idea ${idea.id}: exit order placed — ${leg} ${qty} @ ${lvl.level} (acct ${acct})`)
                    } catch (err) {
                        logger.error(LOG, `Idea ${idea.id}: exit order place failed (${leg} @ ${lvl.level}): ${err.message}`)
                    }
                }
            }
        }

        // Mark the account handled even when nothing was placed, so a repeat
        // open/fill event doesn't re-attempt.
        await db.collection(COLLECTION).updateOne(
            { id: idea.id },
            {
                $push: {
                    ...(newOrders.length ? { exitOrders: { $each: newOrders } } : {}),
                    exitPlacedAccounts: acct,
                },
            },
        )
    } catch (err) {
        logger.error(LOG, `Idea ${idea.id}: _placeExits error: ${err.message}`)
    }
}

/**
 * Re-sync an account's working exit orders to the current remaining position: any
 * resting order whose quantity now exceeds the remaining is shrunk (cancel + place
 * smaller) or cancelled if nothing remains — so it can never over-close and flip the
 * netting position. Market orders fill instantly and are never resized.
 */
async function _resyncExits(db, idea, accountId) {
    const acct      = String(accountId)
    const remaining = _remainingForAccount(idea, acct)
    const orders    = idea.exitOrders ?? []
    let changed     = false

    for (let i = 0; i < orders.length; i++) {
        const o = orders[i]
        if (o.status !== 'working' || String(o.accountId) !== acct || o.type === 'market') continue
        if (Number(o.quantity) <= remaining + EPS) continue   // still safe

        try {
            await brokerService.cancelOrder(o.broker, idea.userId, acct, o.orderId)
        } catch (err) {
            logger.warn(LOG, `Idea ${idea.id}: resync cancel failed (order ${o.orderId}): ${err.message}`)
            continue   // leave it; we'll retry on the next reduction
        }

        if (remaining <= EPS) {
            orders[i] = { ...o, status: 'cancelled', cancelledAt: Date.now() }
            changed = true
            continue
        }
        try {
            const placed = await _placeOneExit(idea, acct, o.broker, o.leg, o.price, remaining, o.positionId)
            orders[i] = { ...o, orderId: placed.orderId, quantity: remaining }
            logger.info(LOG, `Idea ${idea.id}: exit order resized — ${o.leg} → ${remaining} @ ${o.price}`)
        } catch (err) {
            logger.error(LOG, `Idea ${idea.id}: resync re-place failed (${o.leg} @ ${o.price}): ${err.message}`)
            orders[i] = { ...o, status: 'cancelled', cancelledAt: Date.now() }
        }
        changed = true
    }

    if (changed) await db.collection(COLLECTION).updateOne({ id: idea.id }, { $set: { exitOrders: orders } })
}

/** Cancel every still-working exit order for an account (called on a full close). */
async function _cancelWorkingExits(db, idea, accountId) {
    const acct   = String(accountId)
    const orders = idea.exitOrders ?? []
    let changed  = false
    for (let i = 0; i < orders.length; i++) {
        const o = orders[i]
        if (o.status !== 'working' || String(o.accountId) !== acct || !o.orderId) continue
        try {
            await brokerService.cancelOrder(o.broker, idea.userId, acct, o.orderId)
            logger.info(LOG, `Idea ${idea.id}: leftover exit order cancelled (${o.leg} @ ${o.price ?? 'mkt'})`)
        } catch (err) {
            logger.warn(LOG, `Idea ${idea.id}: leftover exit cancel failed (order ${o.orderId}): ${err.message}`)
            continue
        }
        orders[i] = { ...o, status: 'cancelled', cancelledAt: Date.now() }
        changed = true
    }
    if (changed) await db.collection(COLLECTION).updateOne({ id: idea.id }, { $set: { exitOrders: orders } })
}

/** Place a single exit order as a CLOSING order (close side, tied to positionId). */
async function _placeOneExit(idea, accountId, broker, leg, level, qty, positionId) {
    const order = {
        symbol:    idea.brokerSymbol ?? idea.asset,
        direction: idea.direction === 'long' ? 'short' : 'long',   // close side
        quantity:  qty,
        type:      leg === 'tp' ? 'limit' : 'stop',
        ...(positionId != null && { positionId }),   // closing order: reduces this position only
    }
    if (leg === 'tp') order.limitPrice = level
    else              order.stopPrice  = level
    const rq = idea.nativeExit?.referenceQuote
    if (rq != null) order.referenceQuote = rq

    const res = await brokerService.placeOrder(broker, idea.userId, accountId, order)
    return { orderId: res?.orderId != null ? String(res.orderId) : null }
}

/** Remaining open quantity (idea units) for an account: entry qty − filled slices. */
function _remainingForAccount(idea, accountId) {
    const acct     = String(accountId)
    const slot     = (idea.brokerOrders ?? []).find(b => String(b.accountId) === acct)
    const entryQty = Number(slot?.quantity) || 0
    const closed   = (idea.exitOrders ?? [])
        .filter(o => o.status === 'filled' && String(o.accountId) === acct)
        .reduce((s, o) => s + (Number(o.quantity) || 0), 0)
    return Math.max(0, _round(entryQty - closed))
}

const _round = n => Math.round((Number(n) || 0) * 10000) / 10000

// ─── Per-(account,position) serialization ─────────────────────────────────────
// Exit-order placement / resync / cancel read-modify-write the idea's exitOrders
// array, so events for the same position must not interleave. A tiny promise-chain
// lock keyed by account+position keeps them sequential.

const _locks = new Map()

function _withLock(accountId, positionId, fn) {
    const key  = `${accountId}:${positionId}`
    const prev = _locks.get(key) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    _locks.set(key, next.finally(() => { if (_locks.get(key) === next) _locks.delete(key) }))
    return next
}

// ─── Resume feeds after a restart ─────────────────────────────────────────────

async function _resumeFeeds() {
    const db = await getDb()
    const ideas = await db.collection(COLLECTION)
        .find(
            // 'resting' included: a working stop entry must keep its feed so the fill
            // (resting → long/short) reconciles even if it happens across a restart.
            { status: { $in: [...ACTIVE, 'resting'] }, brokerOrders: { $exists: true, $ne: [] } },
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
