/**
 * Portfolio review monitor.
 *
 * Runs on every tick. For each portfolio where nextReviewAt <= now and the user
 * hasn't been notified yet for this cycle (notifiedAt < nextReviewAt), sends a
 * single bot message of type 'portfolio_review'. The notification is not re-sent
 * until the user completes or dismisses the review (which bumps nextReviewAt
 * forward via completeReview).
 *
 * Bot notification payload shape (type: 'portfolio_review'):
 *   { portfolioId, portfolioName, reviewCadence, lastReviewAt }
 */

import { portfolioChatService } from '../api/portfolio/portfolioChat.service.js'
import { sendBotMessage }       from '../api/chat/chat.service.js'
import { logger }               from '../services/logger.service.js'

const LOG = '[portfolio.monitor]'

export async function checkPortfolioReviews() {
    const due = await portfolioChatService.getPendingReviews()
    if (!due.length) return

    logger.info(LOG, `${due.length} portfolio(s) due for review`)

    for (const review of due) {
        try {
            await _notify(review)
        } catch (err) {
            logger.error(LOG, `Notify failed for portfolio ${review.portfolioId}`, err.message)
        }
    }
}

async function _notify(review) {
    const { portfolioId, portfolioName, userId, reviewCadence, lastReviewAt, nextReviewAt, notifiedAt } = review

    // Skip if already notified for this cycle (notifiedAt is within the current window).
    const CADENCE_WINDOW_MS = { weekly: 7 * 86400000, monthly: 30 * 86400000, quarterly: 90 * 86400000 }
    const window = CADENCE_WINDOW_MS[reviewCadence] ?? CADENCE_WINDOW_MS.monthly
    if (notifiedAt != null && notifiedAt >= nextReviewAt - window) {
        return
    }

    const content = `Time to review your portfolio "${portfolioName}" — check if the thesis and allocations still fit your goals.`
    await sendBotMessage(userId, content, 'portfolio_review', {
        portfolioId,
        portfolioName,
        reviewCadence,
        lastReviewAt: lastReviewAt ?? null,
    })

    // Mark as notified so we don't spam on every tick.
    await portfolioChatService.setPortfolioLifecycle(portfolioId, userId, { notifiedAt: Date.now() })
    logger.info(LOG, `Review notification sent for portfolio ${portfolioId} ("${portfolioName}")`)
}
