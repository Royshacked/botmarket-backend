// Coverage notifications (Analyst) — two kinds:
//
// 1. coverage_event (P5): the coverage MONITOR fired a material verdict (target hit, thesis broken,
//    validating, diverging). DEAD until the DB refresh: house-owned coverage has no userId, so the
//    fan-out target is unknown. Wire after the refresh — admin user IDs, not coverage.userId.
//
// 2. coverage_refreshed (G1): Prometheus pinged a specific user after an async refresh-by-hop
//    (Atlas mid-review). This one IS live: the userId comes from the requesting user, not the doc.

import { cardActions } from '../api/chat/chat.service.js'
import { postCard } from './notifyCard.js'

const LOG = '[coverageNotify]'

// ─── Coverage refresh (G1) ──────────────────────────────────────────────────────
// Prometheus pings the user when an async refresh-by-hop (requested by Atlas mid-review) has rewritten
// a held name's coverage — so the user can reopen the review and Atlas reads the fresh artifact. When
// the refresh carries a portfolioId the card routes back to that review; otherwise it opens coverage.

/**
 * Build the "research refreshed" card. Pure → { userId, content, type, payload, botId, actions } or null.
 * `ok:false` = the refresh couldn't produce updated coverage (the existing thesis is left in place).
 */
export function buildCoverageRefreshed({ userId, ticker, portfolioId = null, portfolioName = null, coverageId = null, summary = null, ok = true }) {
    const sym = String(ticker ?? '').toUpperCase().trim()
    if (!userId || !sym) return null
    const forBook = portfolioName ? ` for "${portfolioName}"` : ''
    const gist    = (ok && typeof summary === 'string' && summary.trim())
        ? ` — ${summary.trim().length > 140 ? summary.trim().slice(0, 137) + '…' : summary.trim()}`
        : ''
    const content = ok
        ? `Fresh research on ${sym} is ready${forBook}${gist}. Resume the review to fold it in.`
        : `Couldn't refresh research on ${sym} right now — leaving the existing coverage in place. You can resume the review.`
    return {
        userId,
        content,
        type:       'coverage_refreshed',
        payload:    { kind: 'coverage', symbol: sym, coverageId, portfolioId, ok },
        botId:      'analyst',
        actions:    portfolioId ? cardActions('Resume review') : cardActions('Open coverage'),
        visibility: 'own',
        forUserId:  userId,
    }
}

/** Post the coverage-refresh card (fire-and-forget; never throws into the refresh hop). */
export async function notifyCoverageRefreshed(args) {
    return postCard(buildCoverageRefreshed(args), { tag: 'Coverage-refresh card', log: LOG })
}
