/**
 * Themis — the portfolio (book-level) monitor. Atlas's own loop, the portfolio-side sibling of
 * Hermes (trades). Standalone: its OWN self-scheduling poll loop, sharing no state with Minos/Hermes
 * (the Minos tick that once carried the portfolio-review check is going away).
 *
 * DOORBELL model (LLM-free by design): Themis decides WHEN and WHY to look; Atlas — opened in review
 * mode from the card — decides WHAT to do. It runs ONLY for in-position books (the due-selection
 * filters to liveCount ≥ 1) and is mostly asleep — long-term holds must not be intrabar-monitored.
 *
 * Two-plus gates, all cheap + deterministic:
 *   • scheduled     — the review cadence (weekly/monthly/quarterly) via `nextReviewAt`.
 *   • event (EOD)   — a once-daily read of the cheap trigger panel (earnings imminent / adverse book
 *                     move / regime flip / drift / conviction drop) via computeReviewSignals.
 *   • coverage-delta — a held name's Prometheus coverage flipped terminal (folded into the trigger
 *                      panel by computeReviewSignals, artifact-mediated).
 * Any gate → ONE `portfolio_review` notification to social chat (Atlas bot) → routes to review mode.
 *
 * Self-scheduling: each book leases its own `themis.next_check_at` forward to the next EOD anchor, so
 * the gate is evaluated ~once a day at settled end-of-day state — not on intraday noise. The hourly
 * loop just catches that boundary; the per-book clock is the real cadence. A future, more automated
 * Themis slots an assessment step in AFTER a gate trips ("gate → assess → notify") without reshaping
 * the loop — today the reaction is simply "notify."
 */

import { portfolioChatService } from '../api/portfolio/portfolioChat.service.js'
import { postBotCard, cardActions } from '../api/chat/chat.service.js'
import { withTimeout, createPollLoop } from './monitorUtils.js'
import { logger } from '../services/logger.service.js'

const LOG = '[themis.monitor]'

// Tick hourly; each book self-gates to ~daily via themis.next_check_at (the EOD anchor).
const POLL_INTERVAL_MS = 60 * 60 * 1000
// A single book's check must never wedge the loop (computeReviewSignals hits broker + FMP).
const CHECK_TIMEOUT_MS = 60_000
// EOD anchor (UTC hour). ~US regular-session close (16:00 ET = 20:00 UTC in EDT / 21:00 UTC in EST);
// 21:00 UTC lands at-or-after the bell year-round. The ±1h DST drift is immaterial for a daily gate.
const EOD_ANCHOR_HOUR_UTC = 21

// How long after nextReviewAt a scheduled notification is still considered "already sent this cycle"
// (matches the review cadences) — prevents re-nudging every EOD until the user completes the review.
const CADENCE_WINDOW_MS = { weekly: 7 * 86400000, monthly: 30 * 86400000, quarterly: 90 * 86400000 }

const _loop = createPollLoop({ intervalMs: POLL_INTERVAL_MS, tick: _tick, eager: true, log: LOG, name: 'themis monitor' })

export const themisService = { start: _loop.start, stop: _loop.stop }

// ─── Poll loop ──────────────────────────────────────────────────────────────────
async function _tick() {
    const now   = Date.now()
    const books = await portfolioChatService.getPendingThemisChecks(now)
    if (!books.length) return

    logger.info(LOG, `${books.length} in-position book(s) due for a Themis check`)
    for (const book of books) {
        try { await withTimeout(_checkBook(book, now, _deps), CHECK_TIMEOUT_MS) }
        catch (err) { logger.error(LOG, `Themis check failed for ${book.portfolioId}:`, err.message) }
    }
}

// Evaluate both gates for ONE in-position book and re-lease its EOD clock. Injectable deps so tests
// exercise the branching (scheduled / event / dedup / quiet) without real signals / notify / DB.
// Pure control flow around three effects: compute signals, (maybe) notify, persist the clock.
export async function _checkBook(book, nowMs, deps = _deps) {
    const { triggers } = await deps.computeSignals(book.portfolioId, book.userId).catch(() => ({ triggers: [] }))

    const scheduledDue = _scheduledDue(book, nowMs)
    const sig          = _eventSig(triggers)
    // The event gate fires only when triggers exist AND the signature changed since the last event
    // notification — so a persistent condition doesn't re-notify every EOD (anti-spam).
    const eventFired   = triggers.length > 0 && sig !== (book.themis?.last_event_sig ?? null)
    // Scheduled takes precedence in the card's framing; event triggers still enrich either card.
    const reason = scheduledDue ? 'scheduled' : (eventFired ? 'event' : null)

    const patch = {
        'themis.next_check_at': _nextEodMs(nowMs, EOD_ANCHOR_HOUR_UTC),
        'themis.last_checked':  nowMs,
        'themis.checks':        (book.themis?.checks ?? 0) + 1,
    }

    if (reason) {
        let notified = false
        try { await deps.notify(book, { reason, triggers }); notified = true }
        catch (err) { logger.warn(LOG, `notify failed for ${book.portfolioId}:`, err.message) }
        // Only record the dedup markers when the card actually went out — a dropped notify stays
        // "unsent" and re-rings on the next EOD (the clock still advances regardless). On success:
        if (notified) {
            if (scheduledDue) patch.notifiedAt = nowMs                     // scheduled-cadence dedup
            // ANY card that displays these triggers has surfaced them → stamp the signature so the
            // event gate won't re-ring the same persisting set (scheduled or event ring alike).
            if (triggers.length) patch['themis.last_event_sig'] = sig
        }
    }

    await deps.setLifecycle(book.portfolioId, book.userId, patch)
    logger.info(LOG, `checked ${book.portfolioId} ("${book.portfolioName}") — reason=${reason ?? 'quiet'}, triggers=${triggers.length}`)
    return { reason, triggers: triggers.length }
}

// ─── Pure decision helpers (unit-tested) ──────────────────────────────────────────

// Is the scheduled review due AND not already notified for this cycle? Mirrors the historical
// checkPortfolioReviews dedup: notifiedAt within (nextReviewAt − cadence window) means the current
// cycle's nudge already went out; a completed/dismissed review clears notifiedAt (completeReview). Pure.
export function _scheduledDue(book, nowMs) {
    const { nextReviewAt, notifiedAt, reviewCadence } = book
    if (nextReviewAt == null || nextReviewAt > nowMs) return false
    const window = CADENCE_WINDOW_MS[reviewCadence] ?? CADENCE_WINDOW_MS.monthly
    if (notifiedAt != null && notifiedAt >= nextReviewAt - window) return false
    return true
}

// Stable signature of a trigger set — sorted `${kind}:${label}` pairs — so the event gate can tell a
// changed condition from a persisting one (dedup). Empty set → null (no event). Pure.
export function _eventSig(triggers) {
    if (!Array.isArray(triggers) || triggers.length === 0) return null
    return triggers.map(t => `${t.kind}:${t.label}`).sort().join('|')
}

// Next EOD anchor as epoch ms: the next occurrence of `anchorHourUtc:00` UTC strictly after nowMs.
// Kept epoch-ms to match the rest of the portfolio lifecycle clock (nextReviewAt/notifiedAt). Pure.
export function _nextEodMs(nowMs, anchorHourUtc = EOD_ANCHOR_HOUR_UTC) {
    const d   = new Date(nowMs)
    const eod = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), anchorHourUtc, 0, 0, 0)
    return eod > nowMs ? eod : eod + 86400000
}

// ─── Notification (the doorbell ring) ─────────────────────────────────────────────

// The card copy. A scheduled cycle reads as a routine "time to review"; an event cycle leads with
// "heads up" — but both carry the flagged triggers and both route to Atlas review mode. Pure.
export function _cardContent(book, reason, triggers) {
    const modeLabel = book.mode ? book.mode.charAt(0).toUpperCase() + book.mode.slice(1) : ''
    const scope     = [modeLabel, book.account].filter(Boolean).join(' · ')
    const scopeTxt  = scope ? ` (${scope})` : ''
    const flagged   = triggers.length
        ? `Flagged: ${triggers.slice(0, 4).map(t => t.label).join('; ')}.`
        : 'Nothing jumped out on a quick check — a look to confirm the thesis still holds.'
    return reason === 'event'
        ? `Heads up on "${book.portfolioName}"${scopeTxt}. ${flagged}`
        : `Time to review your portfolio "${book.portfolioName}"${scopeTxt}. ${flagged}`
}

// ─── Default IO deps ──────────────────────────────────────────────────────────────
const _deps = {
    computeSignals: (portfolioId, userId) => portfolioChatService.computeReviewSignals(portfolioId, userId),
    setLifecycle:   (portfolioId, userId, patch) => portfolioChatService.setPortfolioLifecycle(portfolioId, userId, patch),
    notify:         _defaultNotify,
}
export function _setDeps(d) { Object.assign(_deps, d) }

// Post the review card to social chat under the Atlas (portfolio) bot. The card action routes the
// user into Atlas review mode. Best-effort — a notify failure must never wedge the loop.
async function _defaultNotify(book, { reason, triggers }) {
    logger.info(LOG, 'REVIEW CARD', { portfolioId: book.portfolioId, reason, triggers: triggers.length })
    await postBotCard({
        userId:  book.userId,
        content: _cardContent(book, reason, triggers),
        type:    'portfolio_review',
        payload: {
            portfolioId:   book.portfolioId,
            portfolioName: book.portfolioName,
            mode:          book.mode    ?? null,
            account:       book.account ?? null,
            reviewCadence: book.reviewCadence,
            lastReviewAt:  book.lastReviewAt ?? null,
            reason,
            triggers,
        },
        botId:   'portfolio',
        actions: cardActions('Review portfolio'),
    })
}
