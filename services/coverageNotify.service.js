// Coverage notifications (Prometheus) — two kinds:
//
// 1. coverage_event (P5): the coverage MONITOR fired a material verdict (target hit, thesis broken,
//    validating, diverging). House-owned coverage has no userId, so the audience is DERIVED at
//    delivery time — every admin (`listAdminUserIds`), the same join tiltNotify's review offer uses.
//    Admins, not the roster: coverage is a house artifact that only an admin can revise, and the
//    card asks for exactly that revision (2026-09-14: Prometheus's feed is admin-only, like Pythia's).
//
// 2. coverage_refreshed (G1): Prometheus pinged a specific user after an async refresh-by-hop
//    (Atlas mid-review). The userId comes from the requesting user, not the doc — and that hop is
//    itself admin-only now (portfolio.controller), since it REWRITES house coverage.

import { cardActions, dismissOnly } from '../api/chat/chat.service.js'
import { listAdminUserIds } from '../api/user/user.model.js'
import { postCard }         from './notifyCard.js'
import { logger }           from './logger.service.js'

const LOG = '[coverageNotify]'

// Injectable so the admin fan-out is assertable without a DB — the same seam tiltNotify exposes.
// `post` is still postCard: a test seam, not a second way for a card to reach the user.
const _deps = {
    adminUserIds: ()          => listAdminUserIds(),
    post:         (card, ctx) => postCard(card, ctx),
}
export function _setDeps(d) { Object.assign(_deps, d) }

// ─── Coverage event (P5) ────────────────────────────────────────────────────────

/**
 * Build the coverage-event card for one admin. Pure → { userId, content, type, payload, botId,
 * actions, visibility } or null when there is nobody to tell or nothing to say.
 * verdict = { state, reason, edge_gone } from coverage.assess.classifyGapState.
 */
export function buildCoverageEvent(coverage, verdict, userId) {
    if (!userId || !coverage?.symbol || !verdict?.state) return null
    const sym   = coverage.symbol
    const pt    = coverage.price_target?.value
    const state = verdict.state

    // Body carries NO brand prefix — the card's agent tag (FE: CardAgentTag → AGENTS.analyst)
    // already reads "Prometheus", same as the Atlas/Pythia cards. Keep the copy a plain sentence.
    let content
    if (state === 'target_hit') {
        content = `${sym} reached our price target${pt != null ? ` (${pt})` : ''}`
            + (verdict.edge_gone ? ' — the Street has caught up, so the edge is gone. Consider harvesting.' : '.')
    } else if (state === 'target_hit_early') {
        // Reads as a MISS, not a win — the copy has to say so, or a card announcing "target reached"
        // invites exactly the harvest the verdict is arguing against.
        content = `${sym} reached our price target${pt != null ? ` (${pt})` : ''} far too fast: ${verdict.reason}.`
            + ' Re-modelling rather than closing the call.'
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
        userId,
        content,
        type:       'coverage_event',
        payload:    { kind: 'coverage', symbol: sym, coverageId: coverage.id ?? null, state, edge_gone: !!verdict.edge_gone },
        botId:      'analyst',
        // "Revise thesis", not "Open coverage". This card's primary runs the REVISE doorway — it
        // opens Prometheus on the thesis with the turn already in flight — while the refresh card
        // below merely shows the book. Both said "Open coverage", so the two were indistinguishable
        // in the feed and a user who had just revised one name read the other's click as the desk
        // answering with the wrong thesis. The label is the only thing that told them apart.
        actions:    cardActions('Revise thesis'),
        visibility: 'admin',
    }
}

/**
 * Post the coverage-event card to every admin. Never throws — the caller is a monitor tick.
 * Returns the number of cards posted, so "told nobody" is distinguishable from "told three" in the
 * log rather than both reading as a working notify.
 */
export async function notifyCoverageEvent(coverage, verdict, deps = _deps) {
    // Build once against a placeholder owner to learn whether there is anything to say at all,
    // before paying for the roster read.
    if (!buildCoverageEvent(coverage, verdict, '_')) return 0

    let userIds
    try {
        userIds = await deps.adminUserIds()
    } catch (err) {
        logger.warn(LOG, 'coverage event not delivered — admin roster read failed', err.message)
        return 0
    }

    let posted = 0
    for (const userId of userIds ?? []) {
        const msg = await deps.post(buildCoverageEvent(coverage, verdict, userId), { tag: 'Coverage-event card', log: LOG })
        if (msg) posted++
    }
    return posted
}

// ─── Coverage refresh (G1) ──────────────────────────────────────────────────────
// Prometheus says when a headless refresh has rewritten a name's coverage. Two askers, two audiences:
//
//   • Atlas's refresh-by-hop (mid-review) names the USER who asked. The card is theirs alone — so the
//     user can reopen the review and Atlas reads the fresh artifact. With a portfolioId it routes
//     back to that review; otherwise it opens coverage.
//   • The coverage monitor's SCHEDULED re-model has no user — coverage is house-owned — and the
//     card fans out to every admin, exactly as the monitor's verdict card above does, because the
//     revised thesis is theirs to read and revise.

/**
 * Build the "research refreshed" card for one recipient. Pure → { userId, content, type, payload,
 * botId, actions, visibility } or null. `ok:false` = the refresh couldn't produce updated coverage
 * (the existing thesis is left in place). `house` = a scheduled re-model, not a user's request: the
 * copy stops talking about "the review" and the card is admin-visible rather than own-only.
 */
export function buildCoverageRefreshed({ userId, ticker, portfolioId = null, portfolioName = null, coverageId = null, summary = null, ok = true, house = false }) {
    const sym = String(ticker ?? '').toUpperCase().trim()
    if (!userId || !sym) return null
    const forBook = portfolioName ? ` for "${portfolioName}"` : ''
    const gist    = (ok && typeof summary === 'string' && summary.trim())
        ? ` — ${summary.trim().length > 140 ? summary.trim().slice(0, 137) + '…' : summary.trim()}`
        : ''
    // The copy must promise only what the card's buttons can deliver — "resume the review" belongs
    // to a card that HAS a review behind it. Atlas's hop does not always carry one (the doc above:
    // with a portfolioId it routes back to the review, otherwise it opens coverage), and the failed
    // half said "You can resume the review" either way. That was merely wrong before; now that a
    // failed refresh with no review is posted Dismiss-only, it would name an action with no button.
    const resume = portfolioId ? ' You can resume the review.' : ''
    const content = house
        ? (ok
            ? `Scheduled re-model of ${sym} is in${gist}. Read the revised thesis.`
            : `Scheduled re-model of ${sym} produced nothing to store — the existing coverage stands.`)
        : (ok
            ? `Fresh research on ${sym} is ready${forBook}${gist}.${portfolioId ? ' Resume the review to fold it in.' : ''}`
            : `Couldn't refresh research on ${sym} right now — leaving the existing coverage in place.${resume}`)
    return {
        userId,
        content,
        type:       'coverage_refreshed',
        payload:    { kind: 'coverage', symbol: sym, coverageId, portfolioId, ok, house },
        botId:      'analyst',
        // WHAT CLOSES IT, in three shapes.
        //
        // With a review behind it the ask is the review — work, satisfied when the portfolio write
        // lands (the subject is the portfolio, see cardSubject). That holds whether the refresh
        // succeeded or not: there is still somewhere to go back to.
        //
        // A SUCCESSFUL house refresh asks to READ what it wrote — no write could ever satisfy a
        // 'work' card here, so stamped 'work' it sat "still waiting on you" after being opened,
        // forever. Opening it IS doing it.
        //
        // A FAILED one has nowhere to send anyone: it stored nothing, so the thesis is the one
        // already in the book. It carried "Open coverage" anyway, which only switched to the
        // Analyst desk — and that desk keeps its last conversation, so the click appeared to answer
        // this card with the PREVIOUS name's revise turn. A statement with a Dismiss says what
        // happened and asks for nothing.
        actions:    portfolioId ? cardActions('Resume review')
                  : ok         ? cardActions('Open coverage', { resolvesOn: 'open' })
                  :              dismissOnly(),
        ...(house
            ? { visibility: 'admin' }
            : { visibility: 'own', forUserId: userId }),
    }
}

/**
 * Post the coverage-refresh card(s). Never throws into the refresh hop. With a `userId` it is one
 * card to that user; without one it is a house refresh and every admin gets it. Returns the number
 * of cards posted, so "told nobody" is distinguishable from "told three" in the log.
 */
export async function notifyCoverageRefreshed(args, deps = _deps) {
    if (args?.userId) {
        return (await deps.post(buildCoverageRefreshed(args), { tag: 'Coverage-refresh card', log: LOG })) ? 1 : 0
    }

    let userIds
    try {
        userIds = await deps.adminUserIds()
    } catch (err) {
        logger.warn(LOG, 'house refresh card not delivered — admin roster read failed', err.message)
        return 0
    }

    let posted = 0
    for (const userId of userIds ?? []) {
        const msg = await deps.post(buildCoverageRefreshed({ ...args, userId, house: true }), { tag: 'Coverage-refresh card (house)', log: LOG })
        if (msg) posted++
    }
    return posted
}
