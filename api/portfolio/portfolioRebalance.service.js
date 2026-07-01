/**
 * Portfolio rebalance execution.
 *
 * Applies an accepted `portfolio_update` (the agent's review proposal, confirmed by
 * the user) to the live book. This is the only path that turns a review into real
 * orders. Nothing here runs autonomously — the user confirms the whole block first.
 *
 * Action vocabulary (see trade_portfolio_system_prompt.md "Portfolio Edit Output"):
 *   update_idea  — patch a holding's fields in place (no broker touch)
 *   remove_idea  — delete a NON-live idea doc (pending/waiting only)
 *   exit_idea    — fully close a LIVE position across all its accounts
 *   trim_idea    — partially close a LIVE position (reduceFraction of current size)
 *   add_idea     — create a new portfolio holding (mirrors construction semantics)
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

const LOG        = '[portfolio:rebalance]'
const COLLECTION = 'ideas'
const LIVE       = new Set(['hit', 'long', 'short'])

export async function applyRebalance(portfolioId, userId, update, isAdmin = false) {
    if (!portfolioId) return { ok: false, reason: 'missing_portfolioId' }
    if (!update || !Array.isArray(update.changes) || update.changes.length === 0) {
        return { ok: false, reason: 'no_changes' }
    }

    const results = []
    for (const change of update.changes) {
        try {
            const r = await _applyOne(portfolioId, userId, change, isAdmin)
            results.push({ action: change.action, ideaId: change.ideaId ?? null, ...r })
        } catch (err) {
            logger.error(LOG, `change failed (${change.action})`, err.message)
            results.push({ action: change.action, ideaId: change.ideaId ?? null, ok: false, error: err.message })
        }
    }

    // Trajectory point, then deliberate thesis update (if any), then advance the clock.
    await snapshotConvictions(portfolioId, userId)
    if (update.thesis && typeof update.thesis === 'object') {
        await portfolioChatService.setThesis(portfolioId, userId, update.thesis, 'accepted-rebalance')
    }
    await portfolioChatService.completeReview(portfolioId, userId)
    invalidatePortfolioState(portfolioId, userId)

    logger.info(LOG, 'rebalance applied', { portfolioId, changes: results.length })
    return { ok: true, results }
}

async function _applyOne(portfolioId, userId, change, isAdmin) {
    const db = await getDb()
    switch (change.action) {
        case 'update_idea':
            return ideaService.updateIdea(change.ideaId, change.patch ?? {}, userId, isAdmin)

        case 'remove_idea': {
            const idea = await db.collection(COLLECTION).findOne({ id: change.ideaId }, { projection: { status: 1 } })
            if (idea && LIVE.has(idea.status)) return { ok: false, reason: 'live_use_exit_idea' }
            return ideaService.deleteIdea(change.ideaId, userId, isAdmin)
        }

        case 'exit_idea':
            return _exitIdea(db, change.ideaId, userId, change.reason ?? 'rebalance')

        case 'trim_idea':
            return _trimIdea(db, change.ideaId, userId, change)

        case 'add_idea':
            return _addIdea(db, portfolioId, userId, change.idea)

        default:
            return { ok: false, reason: 'unknown_action' }
    }
}

// Fully close every live leg of a holding. The execution reconciler finalizes the
// idea to 'closed' as the broker reports the closes.
async function _exitIdea(db, ideaId, userId, reason) {
    const idea = await db.collection(COLLECTION).findOne({ id: ideaId })
    if (!idea) return { ok: false, reason: 'not_found' }
    if (idea.userId && idea.userId !== userId) return { ok: false, reason: 'forbidden' }

    const legs = (idea.brokerOrders ?? []).filter(b => b.positionId != null)
    if (legs.length === 0) return { ok: false, reason: 'no_position' }

    let closed = 0, skipped = 0
    for (const leg of legs) {
        if (!brokerService.capabilities(leg.broker)?.closePosition) { skipped++; continue }
        await brokerService.closePosition(leg.broker, userId, leg.accountId, leg.positionId)
        closed++
    }
    await db.collection(COLLECTION).updateOne({ id: ideaId }, { $set: { pendingCloseReason: reason } })
    return { ok: closed > 0, legsClosed: closed, legsSkipped: skipped }
}

// Partially close a holding: close `reduceFraction` of each leg's volume. Records the
// new intended weight (targetAllocationRatio) but leaves quantity to the broker truth
// (the reconciler reconciles the reduce). targetAllocationRatio is advisory only.
async function _trimIdea(db, ideaId, userId, change) {
    const idea = await db.collection(COLLECTION).findOne({ id: ideaId })
    if (!idea) return { ok: false, reason: 'not_found' }
    if (idea.userId && idea.userId !== userId) return { ok: false, reason: 'forbidden' }

    const f = Number(change.reduceFraction)
    if (!(f > 0 && f < 1)) return { ok: false, reason: 'bad_reduceFraction' }

    const legs = (idea.brokerOrders ?? []).filter(b => b.positionId != null)
    if (legs.length === 0) return { ok: false, reason: 'no_position' }

    let trimmed = 0, skipped = 0
    for (const leg of legs) {
        if (!brokerService.capabilities(leg.broker)?.closePosition) { skipped++; continue }
        const qty = Math.floor((leg.quantity ?? 0) * f)
        if (qty <= 0) { skipped++; continue }
        await brokerService.closePosition(leg.broker, userId, leg.accountId, leg.positionId, { quantity: qty })
        trimmed++
    }

    if (change.targetAllocationRatio != null && Number.isFinite(Number(change.targetAllocationRatio))) {
        await db.collection(COLLECTION).updateOne({ id: ideaId }, { $set: { allocationRatio: Number(change.targetAllocationRatio) } })
    }
    return { ok: trimmed > 0, legsTrimmed: trimmed, legsSkipped: skipped }
}

// Create a new holding in the portfolio. Mirrors construction semantics (saveIdea →
// status 'waiting'); inherits the portfolio's accounts/name from an existing holding.
async function _addIdea(db, portfolioId, userId, spec) {
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
    return res?.ok ? { ok: true, ideaId: res.idea?.id ?? null } : { ok: false, reason: 'save_failed' }
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
