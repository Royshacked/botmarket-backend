/**
 * Manual (broker-less real-money) idea lifecycle.
 *
 * The Layer B swap at the IDEA level: where placeOrdersForIdea places broker orders and
 * lets the reconciler flip the idea, these functions are driven by the user's two
 * confirmations. On an entry hit / portfolio activation the app posts a FillCard; the user
 * reports the real fill price+size → confirmManualEntry opens the position and flips the
 * idea long/short. On an exit trigger the app posts a card; the user reports the exit price
 * → confirmManualExit closes it. No broker, no reconciler.
 *
 * See docs/architecture/manual-mode.md.
 */

import { stripId }               from '../../providers/mongodb.provider.js'
import { logger }                from '../../services/logger.service.js'
import { routeExits }            from '../../services/protectionPlan.service.js'
import { openManualPosition, closeManualPosition, reduceManualPosition } from '../broker/manualExecution.service.js'
import { notifyManualEntry, notifyManualExit, entryLegFromIdea, exitLegFromIdea } from '../../services/manualNotify.service.js'
import { tradeCaptureService } from '../../services/tradeCapture.service.js'
import { entityRepo }          from '../../services/entity/entityRepo.service.js'

const LOG = '[manualIdea]'

// Statuses from which a manual leg can still be activated into an entry (not already in a
// position or done).
const ACTIVATABLE = new Set(['waiting', 'looking', 'hit'])

function _own(idea, userId, isAdmin) {
    return !idea.userId || idea.userId === userId || isAdmin
}

function _accountId(idea) {
    return idea.mainAccountId ?? (idea.accounts ?? [])[0] ?? null
}

/**
 * Confirm a user-reported entry fill: open the manual position at the reported price/size
 * and flip the idea to long/short with monitored exits. Idempotent via the ordersPlacedAt
 * guard.
 * @param {string} id
 * @param {{ price:number, quantity?:number }} fill
 */
export async function confirmManualEntry(id, { price, quantity } = {}, userId, isAdmin = false) {
    try {
        const idea = await entityRepo.getById(id)
        if (!idea)                                     return { ok: false, reason: 'not_found' }
        if (!_own(idea, userId, isAdmin))              return { ok: false, reason: 'forbidden' }
        if (idea.broker !== 'manual')                  return { ok: false, reason: 'not_manual' }
        if (idea.ordersPlacedAt)                       return { ok: false, reason: 'already_placed' }
        if (idea.orderState !== 'awaiting_manual_fill')return { ok: false, reason: 'not_awaiting_fill' }

        const accountId = _accountId(idea)
        if (!accountId)                                return { ok: false, reason: 'no_account' }

        const px  = Number(price)
        const qty = quantity != null ? Number(quantity) : Number(idea.quantity)
        if (!(px  > 0)) return { ok: false, reason: 'bad_price' }
        if (!(qty > 0)) return { ok: false, reason: 'bad_quantity' }

        // Atomic claim so a double-submit can't open two positions: only the first caller
        // flips awaiting_manual_fill → manual_filling and proceeds to open.
        const claimed = await entityRepo.claimIf(id, { broker: 'manual', orderState: 'awaiting_manual_fill' }, { orderState: 'manual_filling' })
        if (!claimed) return { ok: false, reason: 'not_awaiting_fill' }

        let positionId
        try {
            positionId = await openManualPosition({
                userId:    idea.userId,
                accountId,
                symbol:    idea.asset,          // manual trades canonical symbols (no aliasing)
                direction: idea.direction,
                qty,
                price:     px,
            })
        } catch (err) {
            // Open failed — release the claim so the user can retry.
            await entityRepo.patch(id, { orderState: 'awaiting_manual_fill' })
            throw err
        }

        // Manual has no venue, so exits stay on the monitor (hasAny turns the leg on; no
        // nativeExit, no residual tree → the full tree is evaluated). EXCEPT portfolio legs:
        // per manual-mode §4b a portfolio exit is user-initiated, so the monitor doesn't
        // drive their stop/TP.
        const route     = await routeExits(idea)
        const monitored = !idea.portfolioId
        const now       = Date.now()
        const status    = idea.direction === 'short' ? 'short' : 'long'
        const set = {
            status, ordersPlacedAt: now, activatedAt: now, orderState: 'placed',
            quantity:     qty,   // the confirmed size drives exit sizing
            brokerOrders: [{ broker: 'manual', accountId, orderId: positionId, positionId, quantity: qty }],
            monitorStop:  monitored && route.stop.hasAny,
            monitorTp:    monitored && route.tp.hasAny,
        }
        const updated = await entityRepo.patchAndGet(id, set)

        // Capture into the analytics ledger — manual has no reconciler, so we call the same
        // capture hook the reconciler uses directly (best-effort; never throws). Reuse means
        // manual trades inherit the origin block + call-reasoning freezing for free.
        await tradeCaptureService.captureOpen(updated, {
            broker: 'manual', accountId, positionId,
            direction: idea.direction, quantity: qty, price: px, at: now,
        })

        logger.info(LOG, `Manual entry confirmed for ${id}: ${status} ${qty} ${idea.asset} @ ${px}`)
        return { ok: true, idea: stripId(updated) }
    } catch (err) {
        logger.error(LOG, `confirmManualEntry failed (${id})`, err)
        return { ok: false, error: err }
    }
}

/**
 * Confirm a user-reported exit fill. A reported `quantity` (or a pending trim size stamped by a
 * portfolio trim) that is strictly LESS than the open size does a PARTIAL close (trim) — the position
 * shrinks and stays open; otherwise the position closes in full and the idea flips 'closed'.
 * @param {string} id
 * @param {{ price:number, quantity?:number }} fill
 */
export async function confirmManualExit(id, { price, quantity } = {}, userId, isAdmin = false) {
    try {
        const idea = await entityRepo.getById(id)
        if (!idea)                        return { ok: false, reason: 'not_found' }
        if (!_own(idea, userId, isAdmin)) return { ok: false, reason: 'forbidden' }
        if (idea.broker !== 'manual')     return { ok: false, reason: 'not_manual' }
        if (idea.status !== 'long' && idea.status !== 'short') return { ok: false, reason: 'not_in_position' }

        const link = (idea.brokerOrders ?? []).find(b => b.positionId != null)
        if (!link) return { ok: false, reason: 'no_position' }

        const px = Number(price)
        if (!(px > 0)) return { ok: false, reason: 'bad_price' }

        const reason = idea.pendingCloseReason ?? 'manual'

        // Partial (trim): a reported size — or the trim size a portfolio rebalance stamped on the idea
        // (pendingTrimQty, robust to an FE that doesn't forward the quantity) — that is smaller than the
        // open size reduces the position and leaves it open. reqQty ≥ open size falls through to a full close.
        const openQty = Number(idea.quantity)
        const reqQty  = quantity != null ? Number(quantity)
            : (idea.pendingTrimQty != null ? Number(idea.pendingTrimQty) : null)
        if (reqQty != null && reqQty > 0 && Number.isFinite(openQty) && reqQty < openQty) {
            const res = await reduceManualPosition({ userId: idea.userId, positionId: link.positionId, qty: reqQty, price: px, reason })
            const remaining    = res?.remainingQty ?? Math.max(0, openQty - reqQty)
            const brokerOrders = (idea.brokerOrders ?? []).map(b =>
                b.positionId === link.positionId ? { ...b, quantity: remaining } : b)
            const updated = await entityRepo.patchAndGet(id, {
                quantity: remaining, brokerOrders,
                pendingTrimQty: null, pendingCloseReason: null,   // consumed
            })
            // A partial trim intentionally does NOT captureClose — that would finalize the trade in the
            // analytics ledger. The FINAL close captures it (a known scaled-out-P&L ledger limitation).
            logger.info(LOG, `Manual trim confirmed for ${id}: closed ${reqQty} @ ${px}, ${remaining} left (pnl ${res?.pnl})`)
            return { ok: true, partial: true, remainingQty: remaining, idea: stripId(updated) }
        }

        const res = await closeManualPosition({ userId: idea.userId, positionId: link.positionId, price: px, reason })

        const now = Date.now()
        const set = {
            status: 'closed', orderState: 'closed', closedReason: reason, closedAt: now,
            chat_state: null, pendingTrimQty: null,
            ...(res?.pnl != null && { realizedPnl: res.pnl }),
        }
        const updated = await entityRepo.patchAndGet(id, set)

        // Patch the open trade to closed in the analytics ledger (best-effort; never throws).
        await tradeCaptureService.captureClose({
            accountId: link.accountId, positionId: link.positionId,
            price: px, reason, pnl: res?.pnl, at: now,
        })

        logger.info(LOG, `Manual exit confirmed for ${id} @ ${px} (${reason}, pnl ${res?.pnl})`)
        return { ok: true, idea: stripId(updated) }
    } catch (err) {
        logger.error(LOG, `confirmManualExit failed (${id})`, err)
        return { ok: false, error: err }
    }
}

/**
 * Activate a manual portfolio: mark every pending manual leg awaiting_manual_fill and post
 * ONE N-leg entry FillCard. "Activate" means the user is entering the basket now (a market
 * entry the user executes), so legs skip condition monitoring for entry.
 * @param {string} portfolioId
 */
export async function activateManualPortfolio(portfolioId, userId, isAdmin = false) {
    try {
        const legs = await entityRepo.listByPortfolio(portfolioId, isAdmin ? null : userId)
        if (!legs.length) return { ok: false, reason: 'not_found' }

        const pending = legs.filter(l => l.broker === 'manual' && !l.ordersPlacedAt && ACTIVATABLE.has(l.status))
        if (!pending.length) return { ok: false, reason: 'nothing_to_activate' }

        const now = Date.now()
        await entityRepo.patchMany(
            pending.map(l => l.id),
            { status: 'hit', entryTriggeredAt: now, orderState: 'awaiting_manual_fill' },
        )

        await notifyManualEntry(pending[0].userId, {
            portfolioId,
            portfolioName: pending[0].portfolioName ?? null,
            legs:          pending.map(entryLegFromIdea),
        })
        logger.info(LOG, `Manual portfolio ${portfolioId} activated — ${pending.length} leg(s) awaiting fill`)
        return { ok: true, legs: pending.length }
    } catch (err) {
        logger.error(LOG, `activateManualPortfolio failed (${portfolioId})`, err)
        return { ok: false, error: err }
    }
}

/**
 * User-initiated portfolio exit (for-now model): the user reports they've exited the basket
 * → post ONE N-leg exit card, one row per still-open manual leg. Each leg closes incrementally
 * via confirmManualExit as its price is submitted; partial baskets are fine (unfilled legs
 * stay open). No monitor drives this — it's the user's call. See manual-mode.md §4b.
 * @param {string} portfolioId
 */
export async function requestManualPortfolioExit(portfolioId, userId, isAdmin = false) {
    try {
        const legs = await entityRepo.listByPortfolio(portfolioId, isAdmin ? null : userId)
        if (!legs.length) return { ok: false, reason: 'not_found' }

        const open = legs.filter(l => l.broker === 'manual' && (l.status === 'long' || l.status === 'short'))
        if (!open.length) return { ok: false, reason: 'nothing_open' }

        await notifyManualExit(open[0].userId, {
            portfolioId,
            portfolioName: open[0].portfolioName ?? null,
            reason:        'manual',
            legs:          open.map(exitLegFromIdea),
        })
        logger.info(LOG, `Manual portfolio ${portfolioId} exit requested — ${open.length} open leg(s)`)
        return { ok: true, legs: open.length }
    } catch (err) {
        logger.error(LOG, `requestManualPortfolioExit failed (${portfolioId})`, err)
        return { ok: false, error: err }
    }
}
