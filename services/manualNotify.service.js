/**
 * Manual-mode social-chat notifications.
 *
 * Broker-less mode can't place or close orders, so the app tells the user what to do at
 * their own broker and waits for them to report the real fill. These are the two cards
 * that drive the whole manual lifecycle, posted through the same bot-message channel as
 * every other specialist notification (invalidation_alert etc.) — NOT the abandoned
 * social-chat router. The frontend renders one unified FillCard (N legs, inline price/qty
 * inputs); each leg references an ideaId the confirm endpoints act on.
 *
 * See docs/architecture/manual-mode.md.
 */

import { sendBotMessage } from '../api/chat/chat.service.js'
import { logger }         from './logger.service.js'

const LOG = '[manualNotify]'

/** One entry leg's UI meta, from an idea doc. */
export function entryLegFromIdea(idea) {
    return {
        ideaId:    idea.id,
        asset:     idea.asset,
        direction: idea.direction,
        quantity:  idea.quantity ?? null,
    }
}

/** One exit leg's UI meta, from an in-position idea doc (carries the position to close). */
export function exitLegFromIdea(idea) {
    const link = (idea.brokerOrders ?? []).find(b => b.positionId != null)
    return {
        ideaId:     idea.id,
        asset:      idea.asset,
        direction:  idea.direction,
        positionId: link?.positionId ?? null,
        quantity:   idea.quantity ?? null,
    }
}

/**
 * Post the "enter at your broker" card. `legs` is 1 item for a single idea, N for a
 * portfolio activation; each leg gets a price (+ editable qty) input in the FillCard, and
 * its position opens the moment the user submits it.
 * @param {string} userId
 * @param {{ legs: object[], portfolioId?: string|null, portfolioName?: string|null }} opts
 */
export async function notifyManualEntry(userId, { legs, portfolioId = null, portfolioName = null }) {
    if (!userId || !Array.isArray(legs) || legs.length === 0) return null
    const content = legs.length === 1
        ? `Manual entry — ${String(legs[0].direction).toUpperCase()} ${legs[0].asset}. Enter your fill at your broker, then confirm your average price and size.`
        : `Manual entry — ${portfolioName || 'portfolio'}: ${legs.length} legs. Enter each at your broker and fill in your average prices.`
    logger.info(LOG, `Manual entry card → user ${userId}: ${legs.map(l => l.asset).join(', ')}`)
    // Attribute to the authoring agent: a portfolio basket is Atlas's, a lone idea is Idea's.
    return sendBotMessage(userId, content, 'manual_entry', { kind: 'entry', portfolioId, portfolioName, legs }, portfolioId ? 'portfolio' : 'idea')
}

/**
 * Post the "close at your broker" card. `legs` is 1 item for an idea exit (monitor-driven,
 * carries the stop/tp `reason`), N for a user-initiated portfolio exit (one row per still-
 * open leg). Each leg closes incrementally via confirmManualExit as its exit price is
 * submitted; partial baskets are fine (unfilled legs stay open, the card waits).
 * @param {string} userId
 * @param {{ legs: object[], reason?: string, portfolioId?: string|null, portfolioName?: string|null }} opts
 */
export async function notifyManualExit(userId, { legs, reason = 'manual', portfolioId = null, portfolioName = null }) {
    if (!userId || !Array.isArray(legs) || legs.length === 0) return null
    const label = reason === 'tp' ? 'Take-profit' : reason === 'stop' ? 'Stop' : 'Exit'
    const content = legs.length === 1
        ? `${label} on ${legs[0].asset} — close at your broker and confirm your exit price.`
        : `Exit ${portfolioName || 'portfolio'} — ${legs.length} open legs. Confirm your exit price for each one you've closed.`
    logger.info(LOG, `Manual exit card → user ${userId}: ${legs.map(l => l.asset).join(', ')} (${reason})`)
    // Attribute to the authoring agent: a portfolio basket is Atlas's, a lone idea is Idea's.
    return sendBotMessage(userId, content, 'manual_exit', { kind: 'exit', reason, portfolioId, portfolioName, legs }, portfolioId ? 'portfolio' : 'idea')
}

export const manualNotifyService = { notifyManualEntry, notifyManualExit, entryLegFromIdea, exitLegFromIdea }
