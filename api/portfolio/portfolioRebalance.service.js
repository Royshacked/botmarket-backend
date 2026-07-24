/**
 * Portfolio rebalance execution.
 *
 * Applies an accepted `portfolio_update` (the agent's review proposal, confirmed by
 * the user) to the live book. This is the only path that turns a review into real
 * orders. Nothing here runs autonomously — the user confirms the whole block first.
 *
 * Action vocabulary (see portfolio_system_prompt.md "Portfolio Edit Output"). A holding is a
 * `portfolio_item` entity, so the actions are `_item` (the legacy `_idea` names remain accepted as
 * aliases — see ACTION_ALIAS — so an in-flight review block can't break on the rename):
 *   update_item  — patch a holding's fields in place (no broker touch)
 *   remove_item  — delete a NON-live holding doc (pending/waiting only)
 *   exit_item    — fully close a LIVE position across all its accounts
 *   trim_item    — partially close a LIVE position (reduceFraction of current size)
 *   add_item     — create a new portfolio holding (mirrors construction semantics)
 *   add_to_item  — scale INTO a LIVE position (addFraction of current size)
 *   (swap = exit/trim + add in the same changes array)
 *
 * Per-leg sizing: every close/trim is computed per `brokerOrders[]` entry (account +
 * positionId), never on aggregate. Trim/exit only work on brokers whose
 * capabilities().closePosition is true (cTrader today; IBKR is not).
 *
 * After the moves: snapshot conviction (trajectory point), persist a thesis change if
 * the proposal carried one (reason 'accepted-rebalance'), and advance the review clock.
 */

import { getDb }                    from '../../providers/mongodb.provider.js'
import { logger }                   from '../../services/logger.service.js'
import { ideaService }              from '../trade-ideas/tradeIdeas.service.js'
import { brokerService }            from '../broker/broker.service.js'
import { portfolioChatService }     from './portfolioChat.service.js'
import { invalidatePortfolioState } from '../../services/portfolioState.service.js'
import { notifyManualExit, exitLegFromIdea } from '../../services/manualNotify.service.js'
import { ENTITIES }               from '../../services/entity/entityCollection.js'
import { orderSymbol }            from '../../monitoring/exitOrders.util.js'

const LOG        = '[portfolio:rebalance]'
const COLLECTION = ENTITIES
const LIVE       = new Set(['hit', 'long', 'short'])

export async function applyRebalance(portfolioId, userId, update, isAdmin = false) {
    if (!portfolioId) return { ok: false, reason: 'missing_portfolioId' }
    if (!update || !Array.isArray(update.changes) || update.changes.length === 0) {
        return { ok: false, reason: 'no_changes' }
    }

    const results = []
    const manualExitLegs = []   // manual legs can't be closed programmatically → one Fill card
    for (const change of update.changes) {
        try {
            const r = await _applyOne(portfolioId, userId, change, isAdmin)
            if (r?.manualExitLeg) manualExitLegs.push(r.manualExitLeg)
            results.push({ action: change.action, itemId: change.itemId ?? change.ideaId ?? null, ...r })
        } catch (err) {
            logger.error(LOG, `change failed (${change.action})`, err.message)
            results.push({ action: change.action, itemId: change.itemId ?? change.ideaId ?? null, ok: false, error: err.message })
        }
    }

    // Manual mode: the user reports real fills, so exits post ONE N-leg exit Fill card in
    // social chat (confirmManualExit closes each leg as its price is submitted) instead of
    // placing broker orders. See [[project_paper_trading_sim]] / manual-mode.md §4b.
    let manualExitPosted = false
    if (manualExitLegs.length) {
        const db  = await getDb()
        const sib = await db.collection(COLLECTION).findOne({ portfolioId, userId }, { projection: { portfolioName: 1 } })
        await notifyManualExit(userId, {
            portfolioId,
            portfolioName: sib?.portfolioName ?? null,
            reason:        'rebalance',
            legs:          manualExitLegs,
        })
        manualExitPosted = true
    }

    // Trajectory point, then deliberate thesis update (if any), then advance the clock.
    await snapshotConvictions(portfolioId, userId)
    if (update.thesis && typeof update.thesis === 'object') {
        await portfolioChatService.setThesis(portfolioId, userId, update.thesis, 'accepted-rebalance')
    }
    const rev = await portfolioChatService.completeReview(portfolioId, userId)
    invalidatePortfolioState(portfolioId, userId)

    logger.info(LOG, 'rebalance applied', { portfolioId, changes: results.length, manualExitPosted })
    return { ok: true, results, manualExitPosted, nextReviewAt: rev?.nextReviewAt ?? null }
}

// A holding is a `portfolio_item`, so the vocabulary is `_item`. The legacy `_idea` verbs are still
// accepted (a review block built before the rename, or an FE not yet updated) — normalized here.
const ACTION_ALIAS = {
    update_idea: 'update_item', remove_idea: 'remove_item', exit_idea: 'exit_item',
    trim_idea:   'trim_item',   add_idea:    'add_item',    add_to_idea: 'add_to_item',
}

async function _applyOne(portfolioId, userId, change, isAdmin) {
    const db     = await getDb()
    const action = ACTION_ALIAS[change.action] ?? change.action
    // Back-compat: the id/spec fields were `ideaId`/`idea` before the portfolio_item rename.
    const itemId = change.itemId ?? change.ideaId
    const spec   = change.item   ?? change.idea
    switch (action) {
        case 'update_item':
            return ideaService.updateIdea(itemId, change.patch ?? {}, userId, isAdmin)

        case 'remove_item': {
            const item = await db.collection(COLLECTION).findOne({ id: itemId }, { projection: { status: 1 } })
            if (item && LIVE.has(item.status)) return { ok: false, reason: 'live_use_exit_item' }
            return ideaService.deleteIdea(itemId, userId, isAdmin)
        }

        case 'exit_item':
            return _exitItem(db, itemId, userId, change.reason ?? 'rebalance')

        case 'trim_item':
            return _trimItem(db, itemId, userId, change)

        case 'add_item':
            return _addItem(db, portfolioId, userId, spec)

        case 'add_to_item':
            return _addToItem(db, itemId, userId, change)

        default:
            return { ok: false, reason: 'unknown_action' }
    }
}

// Fully close every live leg of a holding. The execution reconciler finalizes the
// idea to 'closed' as the broker reports the closes.
async function _exitItem(db, itemId, userId, reason) {
    const item = await db.collection(COLLECTION).findOne({ id: itemId })
    if (!item) return { ok: false, reason: 'not_found' }
    if (item.userId && item.userId !== userId) return { ok: false, reason: 'forbidden' }

    const legs = (item.brokerOrders ?? []).filter(b => b.positionId != null)
    if (legs.length === 0) return { ok: false, reason: 'no_position' }

    // Manual: can't place a broker close — hand the exit leg back so applyRebalance posts
    // ONE Fill card; the user confirms the real exit price (confirmManualExit finalizes it).
    if (legs.some(l => l.broker === 'manual')) {
        await db.collection(COLLECTION).updateOne({ id: itemId }, { $set: { pendingCloseReason: reason } })
        return { ok: true, manual: true, manualExitLeg: exitLegFromIdea(item) }
    }

    let closed = 0, skipped = 0
    for (const leg of legs) {
        if (!brokerService.capabilities(leg.broker)?.closePosition) { skipped++; continue }
        await brokerService.closePosition(leg.broker, userId, leg.accountId, leg.positionId)
        closed++
    }
    await db.collection(COLLECTION).updateOne({ id: itemId }, { $set: { pendingCloseReason: reason } })
    return { ok: closed > 0, legsClosed: closed, legsSkipped: skipped }
}

// Partially close a holding: close `reduceFraction` of each leg's volume. Records the
// new intended weight (targetAllocationRatio) but leaves quantity to the broker truth
// (the reconciler reconciles the reduce). targetAllocationRatio is advisory only.
export async function _trimItem(db, itemId, userId, change) {
    const item = await db.collection(COLLECTION).findOne({ id: itemId })
    if (!item) return { ok: false, reason: 'not_found' }
    if (item.userId && item.userId !== userId) return { ok: false, reason: 'forbidden' }

    const f = Number(change.reduceFraction)
    if (!(f > 0 && f < 1)) return { ok: false, reason: 'bad_reduceFraction' }

    const legs = (item.brokerOrders ?? []).filter(b => b.positionId != null)
    if (legs.length === 0) return { ok: false, reason: 'no_position' }

    // Manual: no broker to hit — hand the trim back as a PARTIAL exit leg so applyRebalance posts a
    // Fill card. confirmManualExit reduces the position (not full close) using the reported size, or the
    // pendingTrimQty stamped here if the FE doesn't forward a quantity. Stamp both so the confirm is
    // robust. (A manual holding is a single manual leg.)
    if (legs.some(l => l.broker === 'manual')) {
        const leg     = legs.find(l => l.broker === 'manual')
        const openQty = leg.quantity ?? item.quantity ?? 0
        const trimQty = Math.floor(openQty * f)
        if (trimQty <= 0) return { ok: false, reason: 'trim_too_small' }
        await db.collection(COLLECTION).updateOne({ id: itemId }, { $set: { pendingCloseReason: 'trim', pendingTrimQty: trimQty } })
        return { ok: true, manual: true, manualExitLeg: {
            ideaId:       item.id,
            asset:        item.asset,
            direction:    item.direction,
            positionId:   leg.positionId,
            quantity:     trimQty,
            partial:      true,
            remainingQty: openQty - trimQty,
        } }
    }

    let trimmed = 0, skipped = 0
    for (const leg of legs) {
        if (!brokerService.capabilities(leg.broker)?.closePosition) { skipped++; continue }
        const qty = Math.floor((leg.quantity ?? 0) * f)
        if (qty <= 0) { skipped++; continue }
        await brokerService.closePosition(leg.broker, userId, leg.accountId, leg.positionId, { quantity: qty })
        trimmed++
    }

    if (change.targetAllocationRatio != null && Number.isFinite(Number(change.targetAllocationRatio))) {
        await db.collection(COLLECTION).updateOne({ id: itemId }, { $set: { allocationRatio: Number(change.targetAllocationRatio) } })
    }
    return { ok: trimmed > 0, legsTrimmed: trimmed, legsSkipped: skipped }
}

// Create a new holding in the portfolio. Mirrors construction semantics (saveIdea →
// status 'waiting'); inherits the portfolio's accounts/name from an existing holding.
async function _addItem(db, portfolioId, userId, spec) {
    if (!spec?.asset) return { ok: false, reason: 'no_asset' }
    const sibling = await db.collection(COLLECTION).findOne(
        { portfolioId, userId },
        { projection: { portfolioName: 1, accounts: 1, mainAccountId: 1 } },
    )
    const res = await ideaService.saveIdea({
        ...spec,
        portfolioId,
        portfolioName: sibling?.portfolioName ?? spec.portfolioName ?? null,
        accounts:      Array.isArray(sibling?.accounts) ? sibling.accounts : [],
        mainAccountId: sibling?.mainAccountId ?? null,
    }, userId)
    return res?.ok ? { ok: true, itemId: res.idea?.id ?? null } : { ok: false, reason: 'save_failed' }
}

// Scale INTO a live holding: place a same-direction market order per leg to increase exposure. A new
// name uses add_item (a fresh 'waiting' holding); this grows an EXISTING live position. A same-direction
// order with NO positionId OPENS/increases (a positionId would make it a CLOSING order); on a hedging
// broker that adds a sibling position under the same item — fine, since trim/exit iterate ALL legs and
// computePortfolioState sums them. Portfolio holdings are review-managed (no native stop/TP), so there
// are no protective exits to grow. `broker` is injectable for tests. targetAllocationRatio is advisory.
// LIMITATION: a holding that DOES carry native exits won't have them resized here.
export async function _addToItem(db, itemId, userId, change, broker = brokerService) {
    const item = await db.collection(COLLECTION).findOne({ id: itemId })
    if (!item) return { ok: false, reason: 'not_found' }
    if (item.userId && item.userId !== userId) return { ok: false, reason: 'forbidden' }
    if (!LIVE.has(item.status)) return { ok: false, reason: 'not_live' }   // not in position → use add_item

    const f = Number(change.addFraction)
    if (!(f > 0)) return { ok: false, reason: 'bad_addFraction' }

    const legs = (item.brokerOrders ?? []).filter(b => b.positionId != null)
    if (legs.length === 0) return { ok: false, reason: 'no_position' }
    // Manual legs can't be placed programmatically (mirrors trim's manual guard).
    if (legs.some(l => l.broker === 'manual')) return { ok: false, reason: 'manual_add_unsupported' }

    const direction = item.direction === 'short' ? 'short' : 'long'
    const symbol    = orderSymbol(item)

    let added = 0, skipped = 0, failed = 0
    const newLegs = []
    for (const leg of legs) {
        if (!broker.capabilities(leg.broker)?.trading) { skipped++; continue }
        const qty = Math.floor((leg.quantity ?? 0) * f)
        if (qty <= 0) { skipped++; continue }
        // Per-leg guard (mirrors placeOrdersForIdea): a failure on one account must NOT abandon a
        // sibling leg whose order already went in unlinked — each success is collected independently.
        try {
            const res = await broker.placeOrder(leg.broker, userId, leg.accountId, { symbol, direction, quantity: qty, type: 'market' })
            newLegs.push({
                broker:     leg.broker,
                accountId:  res?.accountId  ?? leg.accountId,
                orderId:    res?.orderId    ?? null,
                positionId: res?.positionId ?? null,
                quantity:   qty,
            })
            added++
        } catch (err) {
            logger.error(LOG, `add leg failed (${leg.broker}/${leg.accountId})`, err.message)
            failed++
        }
    }

    if (added) {
        // Link the new legs so the reconciler backfills their positionId on fill (matched by orderId),
        // and make sure we're listening for those fills.
        await db.collection(COLLECTION).updateOne({ id: itemId }, { $push: { brokerOrders: { $each: newLegs } } })
        for (const l of newLegs) broker.startExecutionFeed?.(l.broker, userId, l.accountId)?.catch?.(() => {})
        // Record the intended new weight (advisory) only when exposure actually changed.
        if (change.targetAllocationRatio != null && Number.isFinite(Number(change.targetAllocationRatio))) {
            await db.collection(COLLECTION).updateOne({ id: itemId }, { $set: { allocationRatio: Number(change.targetAllocationRatio) } })
        }
    }
    return { ok: added > 0, legsAdded: added, legsSkipped: skipped, ...(failed ? { legsFailed: failed } : {}) }
}

// Append a conviction snapshot to each holding so the next review can show the
// trajectory (current vs prior). Called on every review close (accept or dismiss).
export async function snapshotConvictions(portfolioId, userId) {
    try {
        const db = await getDb()
        const holdings = await db.collection(COLLECTION)
            .find({ portfolioId, userId }, { projection: { id: 1, conviction: 1 } })
            .toArray()
        const now = Date.now()
        for (const h of holdings) {
            if (!h.conviction) continue
            await db.collection(COLLECTION).updateOne(
                { id: h.id },
                { $push: { conviction_history: { $each: [{ at: now, level: h.conviction.level ?? null, score: h.conviction.score ?? null }], $slice: -12 } } },
            )
        }
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'snapshotConvictions failed', err.message)
        return { ok: false }
    }
}
