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
 *   { portfolioId, portfolioName, mode, account, reviewCadence, lastReviewAt, triggers }
 *   - mode:    'live' | 'paper' | 'manual' (the workspace the portfolio is bound to)
 *   - account: human-friendly account label (virtual name, or live login id)
 *   - triggers: [{ kind, severity, label }] — the pre-check's reasons to look (may be empty on a
 *               quiet cycle). NON-LLM; the full memo is generated when the user opens the review.
 */

import { portfolioChatService } from '../api/portfolio/portfolioChat.service.js'
import { postBotCard, cardActions } from '../api/chat/chat.service.js'
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

    // Cheap NON-LLM pre-check: what changed since the fingerprint that's worth a look. The full
    // memo is still generated when the user opens the review (the "pre-check only" model).
    const { triggers } = await portfolioChatService.computeReviewSignals(portfolioId, userId).catch(() => ({ triggers: [] }))
    const flagged = triggers.length
        ? `Flagged: ${triggers.slice(0, 4).map(t => t.label).join('; ')}.`
        : 'Nothing jumped out on a quick check — a look to confirm the thesis still holds.'

    const modeLabel = mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : ''
    const scope     = [modeLabel, account].filter(Boolean).join(' · ')
    const content = `Time to review your portfolio "${portfolioName}"${scope ? ` (${scope})` : ''}. ${flagged}`
    await postBotCard({
        userId,
        content,
        type:    'portfolio_review',
        payload: {
            portfolioId,
            portfolioName,
            mode:    mode    ?? null,
            account: account ?? null,
            reviewCadence,
            lastReviewAt: lastReviewAt ?? null,
            triggers,
        },
        botId:   'portfolio',   // portfolio reviews are Atlas's — post under the Atlas (portfolio) bot
        actions: cardActions('Review portfolio'),
    })

    // Mark as notified so we don't spam on every tick.
    await portfolioChatService.setPortfolioLifecycle(portfolioId, userId, { notifiedAt: Date.now() })
    logger.info(LOG, `Review notification sent for portfolio ${portfolioId} ("${portfolioName}")`)
}
