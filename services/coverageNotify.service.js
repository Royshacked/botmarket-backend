// Coverage-event notifications (P5) — the Analyst bot posts to social chat when the coverage monitor
// reaches a material verdict on a living thesis (target hit, thesis broken, validating, diverging).
// Mirrors tradeNotify: a PURE builder (unit-tested) + a thin async wrapper over postBotCard. Each
// agent owns its own notifications (Idea→invalidation, Kairos→readiness, Analyst→coverage events).

import { postBotCard, cardActions } from '../api/chat/chat.service.js'
import { logger } from './logger.service.js'

const LOG = '[coverageNotify]'

/**
 * Build the coverage-event card for a monitor verdict. Pure → returns
 * { userId, content, type, payload, botId } (or null when there's no user to notify).
 * verdict = { state, reason, edge_gone } from coverage.assess.classifyGapState.
 */
export function buildCoverageEvent(coverage, verdict) {
    if (!coverage?.user_id || !verdict?.state) return null
    const sym = coverage.symbol
    const pt  = coverage.price_target?.value
    const state = verdict.state

    // Body carries NO brand prefix — the card's agent tag (FE: CardAgentTag → AGENTS.analyst)
    // already reads "Prometheus", same as the Idea/Atlas cards. Keep the copy a plain sentence.
    let content
    if (state === 'target_hit') {
        content = `${sym} reached our price target${pt != null ? ` (${pt})` : ''}`
            + (verdict.edge_gone ? ' — the Street has caught up, so the edge is gone. Consider harvesting.' : '.')
    } else if (state === 'thesis_broken') {
        content = `${sym} thesis BROKEN: ${verdict.reason}.`
    } else if (state === 'validating') {
        content = `${sym} thesis is playing out: ${verdict.reason}.`
    } else if (state === 'diverging') {
        content = `${sym}: ${verdict.reason} — we're increasingly contrarian; worth a re-look.`
    } else {
        return null   // 'stable' and anything else → no notification
    }

    return {
        userId:  coverage.user_id,
        content,
        type:    'coverage_event',
        payload: { kind: 'coverage', symbol: sym, coverageId: coverage.id, state, edge_gone: !!verdict.edge_gone },
        botId:   'analyst',
        actions: cardActions('Open coverage'),
    }
}

/** Post the coverage-event card (fire-and-forget; never throws into the monitor loop). */
export async function notifyCoverageEvent(coverage, verdict) {
    const card = buildCoverageEvent(coverage, verdict)
    if (!card) return null
    try {
        return await postBotCard(card)
    } catch (err) {
        logger.warn(LOG, 'notify failed', err.message)
        return null
    }
}

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
        type:    'coverage_refreshed',
        payload: { kind: 'coverage', symbol: sym, coverageId, portfolioId, ok },
        botId:   'analyst',
        actions: portfolioId ? cardActions('Resume review') : cardActions('Open coverage'),
    }
}

/** Post the coverage-refresh card (fire-and-forget; never throws into the refresh hop). */
export async function notifyCoverageRefreshed(args) {
    const card = buildCoverageRefreshed(args)
    if (!card) return null
    try {
        return await postBotCard(card)
    } catch (err) {
        logger.warn(LOG, 'refresh notify failed', err.message)
        return null
    }
}
