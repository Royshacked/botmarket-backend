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

    let content
    if (state === 'target_hit') {
        content = `The Analyst — ${sym} reached our price target${pt != null ? ` (${pt})` : ''}`
            + (verdict.edge_gone ? ' — the Street has caught up, so the edge is gone. Consider harvesting.' : '.')
    } else if (state === 'thesis_broken') {
        content = `The Analyst — ${sym} thesis BROKEN: ${verdict.reason}.`
    } else if (state === 'validating') {
        content = `The Analyst — ${sym} thesis is playing out: ${verdict.reason}.`
    } else if (state === 'diverging') {
        content = `The Analyst — ${sym}: ${verdict.reason} — we're increasingly contrarian; worth a re-look.`
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
