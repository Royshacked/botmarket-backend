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
 *   • position.reduced (partial) → an exit fill. Mark a matched slice filled, then ask
 *                                  the broker whether the position survived: if it's
 *                                  GONE (a single event reported as a reduce, or an
 *                                  untracked panel exit, can still fully close), finalise
 *                                  the close; otherwise re-sync the remaining working
 *                                  exits to the broker's live size (netting safety).
 *   • position.closed (full)     → idea status → 'closed' (+ reason / pnl / closedAt),
 *                                  then cancel EVERY working broker order bound to the
 *                                  position — tracked exits AND ones added/dragged via
 *                                  the edit-orders panel — so a resting opposite order
 *                                  can't open a new position on a netting/hedging account.
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
import { tradeCaptureService } from '../services/tradeCapture.service.js'
import { round, remainingForAccount } from './monitorUtils.js'
import { buildExitOrder, exitOrderRecord } from './exitOrders.util.js'
import { entityRepo }    from '../services/entity/entityRepo.service.js'

const LOG        = '[execution.reconciler]'
const ACTIVE     = ['long', 'short']
const EPS        = 1e-6   // quantity comparison slack

// Injection seam (matches the Hermes monitor's `_deps` pattern). Defaults ARE the real
// singletons, so production behavior is byte-identical — the seam is inert unless a test
// overrides it. Enables the regression harness to drive the reconciler against fakes without
// real IO. See ENTITY_MODEL.md P1b.
const _deps = { getDb, brokerService, tradeCaptureService, entityRepo }
/** Test-only: override IO deps. Returns a restore fn. */
export function _setDeps(overrides) {
    const prev = { ..._deps }
    Object.assign(_deps, overrides)
    return () => Object.assign(_deps, prev)
}

let _started = false

export const executionReconciler = { start, handleExecution, placeExits }

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
        const db   = await _deps.getDb()
        const idea = await _findActiveByPosition(db, exec.accountId, exec.positionId)
        if (!idea) {
            logger.info(LOG, `No active idea matched closed position ${exec.accountId}/${exec.positionId}`)
            // A simulated venue's positions still get a trade-history close even without a
            // linked idea, so recent-trades reflects them (patches the idealess open from
            // _onOpened). Branch on the event's `simulated` flag, not a broker name, so the
            // reconciler stays broker-agnostic (a second sim/backtest venue works unchanged).
            if (exec.simulated) {
                await _deps.tradeCaptureService.captureClose({
                    accountId: exec.accountId, positionId: exec.positionId,
                    price: exec.price, reason: exec.reason, pnl: exec.pnl,
                    commission: exec.commission, spread: exec.spread, at: exec.at,
                })
            }
            return
        }

        // Attribute the close: a matched exit order's leg is the reason (native LIMIT
        // ⇒ tp / STOP ⇒ stop, or a monitor market close); else a monitor full-close
        // stamped pendingCloseReason; else whatever the broker reported.
        const matched = (idea.exitOrders ?? []).find(o => exec.orderId != null && String(o.orderId) === String(exec.orderId))
        const reason  = matched?.leg ?? idea.pendingCloseReason ?? exec.reason ?? 'broker'

        await _finalizeClose(db, idea, {
            reason, pnl: exec.pnl, at: exec.at, accountId: exec.accountId, positionId: exec.positionId, price: exec.price,
            commission: exec.commission, spread: exec.spread,
        })
    })
}

async function _onReduced(exec) {
    if (exec.positionId == null) return
    await _withLock(exec.accountId, exec.positionId, async () => {
        const db   = await _deps.getDb()
        const idea = await _findActiveByPosition(db, exec.accountId, exec.positionId)
        if (!idea) return

        // Record the slice if it matches one of our tracked exit orders (a native resting
        // order, or a market close the monitor placed). An UNMATCHED closing fill — e.g. a
        // stop/TP added or dragged through the edit-orders panel, which the panel places
        // straight at the broker without touching exitOrders — can't be sized from our
        // records, so we don't mark a slice; the broker check below is then authoritative.
        const orders = idea.exitOrders ?? []
        const idx = orders.findIndex(o =>
            o.status === 'working' &&
            String(o.accountId) === String(exec.accountId) &&
            exec.orderId != null && String(o.orderId) === String(exec.orderId))

        let matched = null
        if (idx >= 0) {
            orders[idx] = { ...orders[idx], status: 'filled', filledAt: exec.at ?? Date.now() }
            matched = orders[idx]
            await _deps.entityRepo.setExitOrders(idea.id, orders)
            logger.info(LOG, `Idea ${idea.id}: exit slice filled — ${matched.leg} ${matched.quantity} @ ${matched.price ?? 'mkt'}`)
        } else {
            logger.info(LOG, `Idea ${idea.id}: closing fill on ${exec.accountId}/${exec.positionId} (order ${exec.orderId}) not tracked — asking broker if the position survived`)
        }

        // The broker is the only authority on whether the position survived this fill: a
        // single event it reports as a "reduce", or an untracked panel exit, can still
        // have FULLY closed the position. findOpenPosition throws on a transport error
        // (we defer, never false-close) and returns null only when the position is gone.
        const broker   = _brokerFor(idea, exec.accountId)
        let position
        try {
            position = broker
                ? await _deps.brokerService.findOpenPosition(broker, idea.userId, exec.accountId, exec.positionId)
                : undefined   // unknown broker linkage — fall back to tracked-size resync
        } catch (err) {
            logger.warn(LOG, `Idea ${idea.id}: position check failed (${err.message}) — deferring to next event`)
            return
        }

        if (position === null) {
            // Position is gone → finalize the close and cancel any leftover exits (incl.
            // an untracked panel order that wasn't the one that filled — the orphan case).
            const reason = matched?.leg ?? exec.reason ?? 'broker'
            await _finalizeClose(db, { ...idea, exitOrders: orders }, {
                reason, pnl: exec.pnl, at: exec.at, accountId: exec.accountId, positionId: exec.positionId, price: exec.price,
                commission: exec.commission, spread: exec.spread,
            })
            return
        }

        // Still open → shrink/cancel any tracked working exit that now exceeds the
        // position's live remaining size (netting safety). Prefer the broker's volume as
        // the source of truth (handles panel-managed fills our records never saw); fall
        // back to deriving it from tracked slices when the broker is unreachable.
        const remaining = position != null ? round(Number(position.volume)) : undefined
        if (position != null || matched) {
            await _resyncExits(db, { ...idea, exitOrders: orders }, exec.accountId, remaining)
        }
    })
}

async function _onOpened(exec) {
    if (exec.positionId == null) return
    const db = await _deps.getDb()

    // Resting entry filled: a broker-native stop-market entry the idea was holding
    // as a working order (status 'resting', orderId linked, positionId not yet set).
    // The fill opens the position — flip the idea live and stamp the positionId so a
    // later close reconciles. Matched on accountId + orderId (the resting linkage).
    if (exec.orderId != null) {
        const direction = exec.direction === 'short' ? 'short' : 'long'
        const resting = await _deps.entityRepo.claimRestingFill(exec.accountId, exec.orderId, {
            status:         direction,
            orderState:     'placed',
            ordersPlacedAt: exec.at ?? Date.now(),
            activatedAt:    exec.at ?? Date.now(),
            'brokerOrders.$[slot].positionId': String(exec.positionId),
        })
        if (resting) {
            logger.info(LOG, `Resting entry filled → idea ${resting.id} now ${direction} (position ${exec.positionId})`)
            await _deps.tradeCaptureService.captureOpen(resting, exec)
            await _withLock(exec.accountId, exec.positionId, () => placeExits(db, resting, exec.accountId))
            return
        }
    }

    // Already linked? Then the position was stamped inline (a market/immediate entry) or
    // this is a re-delivery — nothing to backfill, but capture the open (idempotent).
    const linked = await _deps.entityRepo.findLinkedByPosition(exec.accountId, exec.positionId)
    if (linked) {
        await _deps.tradeCaptureService.captureOpen(linked, exec)
        return
    }

    // Find an active idea on this account+symbol with an unlinked order slot and
    // stamp the positionId onto it (positional $ + arrayFilters target one element).
    const result = await _deps.entityRepo.backfillPositionId(exec.accountId, exec.positionId, exec.symbol)
    if (!result) {
        // No idea linkage at all — for a simulated venue, still record the open so the
        // trade appears in history (idealess; idempotent with the idea path above). Flag,
        // not broker name (see _onClosed).
        if (exec.simulated) await _deps.tradeCaptureService.captureOpenBare(exec)
        return
    }
    logger.info(LOG, `Backfilled positionId ${exec.positionId} onto idea ${result.id}`)
    await _deps.tradeCaptureService.captureOpen(result, exec)

    // Position is open — place this account's native exit orders (once).
    await _withLock(exec.accountId, exec.positionId, () => placeExits(db, result, exec.accountId))
}

// ─── Native exit orders ───────────────────────────────────────────────────────

/**
 * Place an account's native exit orders when its position opens — one broker order
 * per multi-level bare-price level (LIMIT for tp, STOP for stop, opposite side),
 * scaled from the idea-unit plan to this account's filled quantity. Idempotent per
 * account via `exitPlacedAccounts`.
 */
async function placeExits(db, idea, accountId) {
    try {
        const acct = String(accountId)

        // Atomically CLAIM this account before placing anything. Both the confirm/place
        // flow (placeOrdersForIdea) and the fill-event reconciler call placeExits, each
        // with its own idea snapshot — the old in-memory `exitPlacedAccounts` guard let
        // both pass (neither had seen the other's write yet) and place the stops/TPs
        // twice. `$addToSet` under a `$ne` filter is atomic: only the first caller
        // matches (modifiedCount 1) and proceeds; the loser no-ops here.
        const claimed = await _deps.entityRepo.claimExitAccount(idea.id, acct)
        if (!claimed) return   // already claimed / placed by another caller

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
                    const qty = round(Number(lvl.quantity) * factor)
                    if (!(qty > 0)) continue
                    try {
                        const placed = await _placeOneExit(idea, acct, slot?.broker, leg, lvl.level, qty, positionId)
                        newOrders.push(exitOrderRecord({
                            accountId: acct, broker: slot?.broker, leg,
                            type: leg === 'tp' ? 'limit' : 'stop',
                            price: lvl.level, quantity: qty, positionId,
                            orderId: placed.orderId,
                        }))
                        logger.info(LOG, `Idea ${idea.id}: exit order placed — ${leg} ${qty} @ ${lvl.level} (acct ${acct})`)
                    } catch (err) {
                        logger.error(LOG, `Idea ${idea.id}: exit order place failed (${leg} @ ${lvl.level}): ${err.message}`)
                    }
                }
            }
        }

        // The account was already marked handled by the atomic claim above (so a
        // repeat open/fill event doesn't re-attempt); only the placed orders remain
        // to record.
        if (newOrders.length) {
            await _deps.entityRepo.pushExitOrders(idea.id, newOrders)
        }
    } catch (err) {
        logger.error(LOG, `Idea ${idea.id}: placeExits error: ${err.message}`)
    }
}

/**
 * Re-sync an account's working exit orders to the current remaining position: any
 * resting order whose quantity now exceeds the remaining is shrunk (cancel + place
 * smaller) or cancelled if nothing remains — so it can never over-close and flip the
 * netting position. Market orders fill instantly and are never resized.
 */
async function _resyncExits(db, idea, accountId, remainingOverride) {
    const acct      = String(accountId)
    // Prefer the broker's live position size when the caller has it (authoritative even
    // for panel-managed fills); otherwise derive it from our tracked filled slices.
    const remaining = remainingOverride != null ? Math.max(0, remainingOverride) : remainingForAccount(idea, acct)
    const orders    = idea.exitOrders ?? []
    let changed     = false

    for (let i = 0; i < orders.length; i++) {
        const o = orders[i]
        if (o.status !== 'working' || String(o.accountId) !== acct || o.type === 'market') continue
        if (Number(o.quantity) <= remaining + EPS) continue   // still safe

        try {
            await _deps.brokerService.cancelOrder(o.broker, idea.userId, acct, o.orderId)
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

    if (changed) await _deps.entityRepo.setExitOrders(idea.id, orders)
}

// ─── Close finalisation ───────────────────────────────────────────────────────

/** The active idea (long/short) holding this account+position in its entry linkage. */
function _findActiveByPosition(db, accountId, positionId) {
    return _deps.entityRepo.findActiveByPosition(accountId, positionId)
}

/** The broker that holds this account's orders for an idea (entry linkage, then exits). */
function _brokerFor(idea, accountId) {
    const acct = String(accountId)
    return (idea.brokerOrders ?? []).find(b => String(b.accountId) === acct)?.broker
        ?? (idea.exitOrders ?? []).find(o => String(o.accountId) === acct)?.broker
        ?? null
}

/**
 * Flip the idea to 'closed' (guarded so a concurrent close wins once) and, on success,
 * cancel EVERY working broker order still bound to the closed position. Shared by the
 * full-close event path and the broker-confirmed full close detected from a reduce.
 */
async function _finalizeClose(db, idea, { reason, pnl, at, accountId, positionId, price, commission, spread }) {
    const patch = { status: 'closed', closedReason: reason, closedAt: at ?? Date.now() }
    if (pnl != null) patch.realizedPnl = pnl

    const result = await _deps.entityRepo.finalizeClose(idea.id, patch)
    if (!result) return false   // someone else closed it first
    logger.info(LOG, `Idea ${result.id} closed by broker (reason=${reason}, pnl=${patch.realizedPnl ?? '·'})`)

    await _deps.tradeCaptureService.captureClose({ accountId, positionId, price, reason, pnl, commission, spread, at })
    await _cancelExitsForPosition(db, result, accountId, positionId)
    return true
}

/**
 * Cancel every still-working broker order bound to a closed position — not just the
 * exits we tracked. A stop/TP added or dragged through the edit-orders panel rests at
 * the broker untracked; on a netting/hedging account it would otherwise OPEN a fresh
 * position after the close, so we list the account's working orders and cancel each one
 * whose positionId matches (leaving other ideas' orders untouched). Falls back to the
 * tracked-only cancel when the broker can't be reached or doesn't list orders.
 */
async function _cancelExitsForPosition(db, idea, accountId, positionId) {
    const acct   = String(accountId)
    const broker = _brokerFor(idea, acct)

    let brokerCancelled = false
    if (broker && positionId != null) {
        try {
            const working = await _deps.brokerService.listOrders(broker, idea.userId, acct)
            const mine    = (working ?? []).filter(o => String(o.positionId) === String(positionId))
            for (const o of mine) {
                try {
                    await _deps.brokerService.cancelOrder(broker, idea.userId, acct, o.orderId)
                    logger.info(LOG, `Idea ${idea.id}: broker exit cancelled (order ${o.orderId}, pos ${positionId})`)
                } catch (err) {
                    logger.warn(LOG, `Idea ${idea.id}: broker exit cancel failed (order ${o.orderId}): ${err.message}`)
                }
            }
            brokerCancelled = true
        } catch (err) {
            logger.warn(LOG, `Idea ${idea.id}: listOrders for cancel-all failed (${err.message}) — falling back to tracked exits`)
        }
    }

    if (!brokerCancelled) {
        await _cancelWorkingExits(db, idea, acct)   // best-effort: cancel only what we tracked
        return
    }

    // Mirror the broker state onto our tracked exits so the idea reflects the cancel.
    const orders = idea.exitOrders ?? []
    let changed  = false
    for (let i = 0; i < orders.length; i++) {
        const o = orders[i]
        if (o.status !== 'working' || String(o.accountId) !== acct) continue
        orders[i] = { ...o, status: 'cancelled', cancelledAt: Date.now() }
        changed = true
    }
    if (changed) await _deps.entityRepo.setExitOrders(idea.id, orders)
}

/** Cancel every still-working exit order for an account (tracked-only fallback). */
async function _cancelWorkingExits(db, idea, accountId) {
    const acct   = String(accountId)
    const orders = idea.exitOrders ?? []
    let changed  = false
    for (let i = 0; i < orders.length; i++) {
        const o = orders[i]
        if (o.status !== 'working' || String(o.accountId) !== acct || !o.orderId) continue
        try {
            await _deps.brokerService.cancelOrder(o.broker, idea.userId, acct, o.orderId)
            logger.info(LOG, `Idea ${idea.id}: leftover exit order cancelled (${o.leg} @ ${o.price ?? 'mkt'})`)
        } catch (err) {
            logger.warn(LOG, `Idea ${idea.id}: leftover exit cancel failed (order ${o.orderId}): ${err.message}`)
            continue
        }
        orders[i] = { ...o, status: 'cancelled', cancelledAt: Date.now() }
        changed = true
    }
    if (changed) await _deps.entityRepo.setExitOrders(idea.id, orders)
}

/** Place a single exit order as a CLOSING order (close side, tied to positionId). */
async function _placeOneExit(idea, accountId, broker, leg, level, qty, positionId) {
    const order = buildExitOrder(idea, {
        type: leg,          // 'stop' | 'tp' → STOP | LIMIT at `level`
        level,
        qty,
        positionId,
        referenceQuote: idea.nativeExit?.referenceQuote ?? null,
    })
    const res = await _deps.brokerService.placeOrder(broker, idea.userId, accountId, order)
    return { orderId: res?.orderId != null ? String(res.orderId) : null }
}

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
    // 'resting' included: a working stop entry must keep its feed so the fill
    // (resting → long/short) reconciles even if it happens across a restart.
    const ideas = await _deps.entityRepo.activeWithBrokerLinks()

    // Distinct (broker, userId, accountId) so we open each account feed once.
    const seen = new Set()
    let count  = 0
    for (const idea of ideas) {
        for (const link of idea.brokerOrders ?? []) {
            const key = `${link.broker}:${idea.userId}:${link.accountId}`
            if (seen.has(key) || !idea.userId || !link.broker || !link.accountId) continue
            seen.add(key)
            try {
                const ok = await _deps.brokerService.startExecutionFeed(link.broker, idea.userId, link.accountId)
                if (ok) count++
            } catch (err) {
                logger.warn(LOG, `resume feed failed (${key}):`, err.message)
            }
        }
    }
    if (count > 0) logger.info(LOG, `Resumed ${count} execution feed(s) for active positions`)
}
