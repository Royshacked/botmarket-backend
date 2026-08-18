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
import { journalEntry }  from './monitorJournal.js'

const LOG        = '[execution.reconciler]'
const EPS        = 1e-6   // quantity comparison slack

// Injection seam (matches the Hermes monitor's `_deps` pattern). Defaults ARE the real
// singletons, so production behavior is byte-identical — the seam is inert unless a test
// overrides it. Enables the regression harness to drive the reconciler against fakes without
// real IO. See docs/architecture/entity-model.md P1b.
const _deps = { getDb, brokerService, tradeCaptureService, entityRepo }
/** Test-only: override IO deps. Returns a restore fn. */
export function _setDeps(overrides) {
    const prev = { ..._deps }
    Object.assign(_deps, overrides)
    return () => Object.assign(_deps, prev)
}

let _started = false

export const executionReconciler = { start, stop, handleExecution, placeExits }

function start() {
    if (_started) return
    _started = true
    executionBus.on('execution', handleExecution)
    logger.info(LOG, 'Execution reconciler listening on executionBus')
    // Resume feeds for positions opened in a previous run (best-effort, async).
    _resumeFeeds().catch(err => logger.error(LOG, 'resumeFeeds error:', err.message))
}

/**
 * Stop reconciling. This is a LISTENER, not a poll loop, so stopping means detaching from the bus:
 * a broker fill arriving mid-shutdown must not start a `read the idea → ask the broker → place
 * exits` sequence that the process will not be alive to finish.
 *
 * It was the only one of the eleven background workers with no way to be stopped — which is
 * pointed: it is also the one holding the in-memory exit-order lock that
 * docs/architecture/single-instance.md ranks as the most dangerous piece of per-process state.
 *
 * Idempotent, and deliberately does NOT tear down broker feeds. Those belong to the session
 * providers that opened them, and a half-owned teardown is how a socket gets closed twice.
 */
function stop() {
    if (!_started) return
    _started = false
    executionBus.off('execution', handleExecution)
    logger.info(LOG, 'Execution reconciler detached from executionBus')
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
                    accountId: exec.accountId, positionId: exec.positionId, orderId: exec.orderId,
                    price: exec.price, quantity: exec.quantity, reason: exec.reason, pnl: exec.pnl,
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
            quantity: exec.quantity, orderId: exec.orderId, commission: exec.commission, spread: exec.spread,
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
        // Hoisted: it gates the ledger write below, not just the log line. `won` is the ONLY
        // exactly-once signal available here — `position.reduced` can arrive twice for one fill.
        let won = false
        if (idx >= 0) {
            const filledAt = exec.at ?? Date.now()
            // Mark this ONE order in place rather than writing the whole array back from a copy —
            // see entityRepo.markExitOrderFilled. The in-memory `orders` is still updated because
            // everything below (the close finalize, the resync) reads the post-fill picture from it.
            won = await _deps.entityRepo.markExitOrderFilled(idea.id, {
                orderId: orders[idx].orderId, accountId: exec.accountId, filledAt,
            })
            orders[idx] = { ...orders[idx], status: 'filled', filledAt }
            matched = orders[idx]
            if (won) {
                logger.info(LOG, `Idea ${idea.id}: exit slice filled — ${matched.leg} ${matched.quantity} @ ${matched.price ?? 'mkt'}`)
            } else {
                // The order was not `working` when we got there — already reconciled by someone
                // else. Carry on: the broker check below is authoritative about the position, and
                // finalizing a close twice is idempotent. Only the log line would be a lie.
                logger.info(LOG, `Idea ${idea.id}: exit slice ${matched.leg} was already marked filled — continuing on the broker's answer`)
            }
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
                quantity: exec.quantity, orderId: exec.orderId, commission: exec.commission, spread: exec.spread,
            })
            return
        }

        // The position survived, so this fill was a SLICE — record it. Nothing used to be written
        // here at all: the slice's realized P&L never reached the ledger, and the eventual full
        // close wrote one trade carrying only the last slice's pnl. Every scaled-out trade was
        // under-reported, in the collection that is canonical analytics and cannot be rebuilt.
        //
        // Gated on `won` (not merely on `matched`): a duplicate reduce event loses that race and
        // must not append a second slice. An UNTRACKED exit has no matched order and, as the branch
        // above says, cannot be sized from our records — recording it would mean inventing a
        // quantity, so it is deliberately left out rather than guessed at.
        if (matched && won) {
            await _deps.tradeCaptureService.capturePartial({
                accountId: exec.accountId, positionId: exec.positionId, orderId: exec.orderId,
                price: exec.price, quantity: exec.quantity, reason: matched.leg ?? exec.reason,
                pnl: exec.pnl, commission: exec.commission, spread: exec.spread, at: exec.at,
            })
        }

        // Still open → shrink/cancel any tracked working exit that now exceeds the
        // position's live remaining size (netting safety). Prefer the broker's volume as
        // the source of truth (handles panel-managed fills our records never saw); fall
        // back to deriving it from tracked slices when the broker is unreachable.
        const remaining = position != null ? round(Number(position.volume)) : undefined
        // Write that truth onto the LEG as well, not just into the exit resync. A reduction we can't
        // match to a tracked exit order — an Atlas trim, a close from the broker's own panel — used
        // to leave `brokerOrders[].quantity` at the pre-trim size forever, and that number is the
        // base every later fraction is computed from: a 50% trim of a holding recorded as 126 but
        // holding 63 closes the whole position. The broker is the authority here, exactly as it is
        // for whether the position survived at all.
        if (remaining != null && Number.isFinite(remaining)) {
            await _syncLegQuantity(idea.id, exec.accountId, exec.positionId, remaining)
        }
        if (position != null || matched) {
            await _resyncExits(db, { ...idea, exitOrders: orders }, exec.accountId, remaining)
        }
    })
}

/**
 * Stamp the broker's live volume onto the leg that holds this position.
 *
 * Deliberately narrow: it touches ONE leg's quantity and nothing else. The entity's own `quantity`
 * is left alone here because this runs for every kind — a legacy idea, a call, a setup, a holding —
 * and on a multi-account entity `quantity` means idea units, not any single account's size. The
 * portfolio paths that DO own that number keep it in step themselves (see `_syncItemQuantity`).
 *
 * Matched on accountId + positionId, the same identity the rest of this file uses: a positionId is
 * only unique within its account.
 */
async function _syncLegQuantity(itemId, accountId, positionId, quantity) {
    try {
        const done = await _deps.entityRepo.setLegQuantity(itemId, { accountId, positionId, quantity })
        if (done) logger.info(LOG, `Idea ${itemId}: leg ${accountId}/${positionId} resized to the broker's ${quantity}`)
    } catch (err) {
        // Never fatal: the exit resync below is the safety-critical half, and a leg whose recorded
        // size is stale is the state we were already in.
        logger.warn(LOG, `leg resize failed on ${itemId} (${accountId}/${positionId})`, err.message)
    }
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
        // A fill on an ALREADY-OPEN position is a scale-in: the position just grew, and the stop
        // resting behind it was sized for what was on BEFORE this leg. Until it covers the new
        // total, part of the position is unprotected — so this runs under the same lock as
        // placement, on every such fill, and no-ops when the cover is already right.
        await _withLock(exec.accountId, exec.positionId, () => _growStops(linked, exec.accountId, exec.positionId))
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

/**
 * Grow the protective cover after a scale-in. The mirror of _resyncExits, and deliberately NOT the
 * same function: that one exists so an exit can never OVER-close, and treats an order smaller than
 * the position as "still safe". Coming the other way that is precisely the danger — an order
 * smaller than the position means part of it has no stop behind it.
 *
 * ADDS a leg rather than resizing the existing one. Cancel-then-replace would leave a window with
 * no protection at all; place-then-cancel would briefly double the cover, which on a netting account
 * can over-close and open a position the other way. Adding the DELTA has neither hazard: the stops
 * sum to the position at every instant, and it composes with a ladder instead of flattening it.
 *
 * Only STOPS. Take-profits are an intentional ladder whose legs are meant to be smaller than the
 * position — growing each to the total would turn a scale-out plan into a full exit.
 *
 * The broker is asked for the live size rather than trusting the fill event, for the same reason
 * _onReduced asks: a single event does not always describe the whole position.
 */
async function _growStops(idea, accountId, positionId) {
    const acct   = String(accountId)
    const broker = _brokerFor(idea, acct)
    if (!broker) return

    let position
    try {
        position = await _deps.brokerService.findOpenPosition(broker, idea.userId, acct, positionId)
    } catch (err) {
        logger.warn(LOG, `Idea ${idea.id}: size check failed (${err.message}) — leaving the stop alone`)
        return   // never guess at protection: an unknown size is not a reason to place an order
    }
    const total = round(Number(position?.volume))
    if (!Number.isFinite(total) || total <= 0) return

    const orders  = idea.exitOrders ?? []
    const stops   = orders.filter(o => o.status === 'working' && String(o.accountId) === acct && o.leg === 'stop')
    if (!stops.length) return   // nothing resting to extend; placement owns the first one

    const covered = stops.reduce((n, o) => n + (Number(o.quantity) || 0), 0)
    const delta   = round(total - covered)
    if (delta <= EPS) return    // already covered — the common case, and a re-delivered event

    try {
        const placed = await _placeOneExit(idea, acct, stops[0].broker, 'stop', stops[0].price, delta, positionId)
        await _deps.entityRepo.setExitOrders(idea.id, [...orders, exitOrderRecord({
            accountId: acct, broker: stops[0].broker, leg: 'stop', type: 'stop',
            price: stops[0].price, quantity: delta, orderId: placed.orderId, positionId,
        })])
        logger.info(LOG, `Idea ${idea.id}: scale-in covered — added ${delta} stop @ ${stops[0].price} (position ${total})`)
    } catch (err) {
        logger.error(LOG, `Idea ${idea.id}: FAILED to cover scale-in (${delta} @ ${stops[0].price}): ${err.message}`)
    }
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
async function _finalizeClose(db, idea, { reason, pnl, at, accountId, positionId, price, quantity, orderId, commission, spread }) {
    const closedAt = at ?? Date.now()
    const patch = { status: 'closed', closedReason: reason, closedAt }
    if (pnl != null) patch.realizedPnl = pnl

    // The exit line. It rides the same guarded write as the status flip, so the close that wins is
    // the close that journals — and a closed entity is out of every polled status before its monitor
    // wakes, which is why this cannot be left to Hermes or Talos.
    const entry = journalEntry('exit', { nowMs: closedAt, entity: idea, price, closedReason: reason, pnl })

    const result = await _deps.entityRepo.finalizeClose(idea.id, patch, entry)
    if (!result) return false   // someone else closed it first
    logger.info(LOG, `Idea ${result.id} closed by broker (reason=${reason}, pnl=${patch.realizedPnl ?? '·'})`)

    await _deps.tradeCaptureService.captureClose({ accountId, positionId, orderId, price, quantity, reason, pnl, commission, spread, at })
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
//
// A promise-chain lock keyed by account+position, so two executions for the same position are
// handled one after the other.
//
// WHAT IT ACTUALLY GUARDS — larger than it looks, and worth stating precisely because the obvious
// reading understates it. It is NOT merely the `exitOrders` write: that specific race is now closed
// in the data by entityRepo.markExitOrderFilled. What the lock still owns is the DECISION WINDOW,
// which spans network IO:
//
//   read the idea → ask the broker whether the position survived → place / cancel / re-size exits
//
// Two reconciliations running that concurrently can both see a surviving position and both act on
// it — cancelling an order the other just placed, or placing a duplicate. No atomic write fixes
// that, because the thing to be made atomic is a sequence of calls to someone else's system.
//
// ⚠ THIS IS A PROCESS-LOCAL LOCK. A second instance does not contend for it — it cannot see it —
// so the interleaving comes straight back on the live order path. That is the single strongest
// reason this backend runs as ONE process, and lifting it needs a Mongo lease over the window above
// plus live broker verification, not a code change alone. See docs/architecture/single-instance.md.

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
