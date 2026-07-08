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
 *   { portfolioId, portfolioName, mode, account, reviewCadence, lastReviewAt }
 *   - mode:    'live' | 'paper' | 'manual' (the workspace the portfolio is bound to)
 *   - account: human-friendly account label (virtual name, or live login id)
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
    const { portfolioId, portfolioName, userId, mode, account, reviewCadence, lastReviewAt, nextReviewAt, notifiedAt } = review

    // Skip if already notified for this cycle (notifiedAt is within the current window).
    const CADENCE_WINDOW_MS = { weekly: 7 * 86400000, monthly: 30 * 86400000, quarterly: 90 * 86400000 }
    const window = CADENCE_WINDOW_MS[reviewCadence] ?? CADENCE_WINDOW_MS.monthly
    if (notifiedAt != null && notifiedAt >= nextReviewAt - window) {
        return
    }

    const modeLabel = mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : ''
    const scope     = [modeLabel, account].filter(Boolean).join(' · ')
    const content = `Time to review your portfolio "${portfolioName}"${scope ? ` (${scope})` : ''} — check if the thesis and allocations still fit your goals.`
    await sendBotMessage(userId, content, 'portfolio_review', {
        portfolioId,
        portfolioName,
        mode:    mode    ?? null,
        account: account ?? null,
        reviewCadence,
        lastReviewAt: lastReviewAt ?? null,
    }, 'portfolio')   // portfolio reviews are Atlas's — post under the Atlas (portfolio) bot

    // Mark as notified so we don't spam on every tick.
    await portfolioChatService.setPortfolioLifecycle(portfolioId, userId, { notifiedAt: Date.now() })
    logger.info(LOG, `Review notification sent for portfolio ${portfolioId} ("${portfolioName}")`)
}
