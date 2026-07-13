/**
 * Confirm-entry + Kairos-call notifications to social chat.
 *
 * "Major event" cards posted through the same bot-message channel as invalidation_alert /
 * manualNotify (sendBotMessage → chat_messages → WS). These are NOTIFY-AND-ROUTE cards: the
 * card is the alert + a clickable preview; the existing action UI is where the user actually
 * acts (paper/live entry → OrderConfirmDialog; a Kairos call → its pop-out detail window, which
 * hosts Confirm-entry / Accept-edit / Delete).
 *
 * Manual-mode fills keep their own inline FillCard (manualNotify) — this covers the two gaps:
 * paper/live entry confirmation (was a silent modal) and Kairos readiness/expiry (was a poll
 * card + a silent 'expired' terminal state).
 *
 * Shape is split into pure builders (unit-tested — the { userId, content, type, payload, botId }
 * a card sends) and thin async wrappers that hand the builder's output to sendBotMessage.
 * Call docs store the owner as `user_id` (see normalizeCall), NOT `userId`.
 */

import { sendBotMessage } from '../api/chat/chat.service.js'
import { logger }         from './logger.service.js'

const LOG = '[tradeNotify]'

// ── Pure card builders ─────────────────────────────────────────────────────────

/**
 * Paper/live idea entry triggered → confirm to place the order (routes to OrderConfirmDialog).
 * `note` marks WHY it surfaced now, so the card can label itself and lead-in copy matches:
 *   'passed_earlier' — armed after a time condition had already elapsed
 *   'off_hours'      — a scheduled time fired while the market was closed; surfaced at open
 *   null             — a normal live trigger
 */
export function buildIdeaEntryConfirm(idea, note = null) {
    const dir  = String(idea?.direction || '').toUpperCase()
    const lead = note === 'passed_earlier' ? `Scheduled time already passed — ${dir} ${idea?.asset}.`
        :        note === 'off_hours'      ? `Scheduled time reached while the market was closed — ${dir} ${idea?.asset}.`
        :                                    `Entry triggered — ${dir} ${idea?.asset}.`
    return {
        userId:  idea?.userId ?? null,
        content: `${lead} Confirm to place your order.`,
        type:    'entry_confirm',
        payload: { kind: 'idea', ideaId: idea?.id, asset: idea?.asset, direction: idea?.direction ?? null, note: note ?? null },
        botId:   'idea',
    }
}

/** Kairos call READY to enter → open the call to confirm. Proposal comes from the fresh assessment. */
export function buildCallReady(call, assessment = null) {
    // Only show the price bits when BOTH numbers finalized — _finalizeProposal returns null for
    // entry/stop it can't resolve, and "entry null, stop null" must never reach the card copy.
    const p       = assessment?.proposal
    // NB: Number.isFinite (no coercion) — Number(null) is 0 (finite), which would leak "stop null".
    const hasNums = p && Number.isFinite(p.entry) && Number.isFinite(p.stop)
    const bits    = hasNums ? ` (entry ${p.entry}, stop ${p.stop})` : ''
    return {
        userId:  call?.user_id ?? null,
        content: `Kairos — ${call?.asset} is ready to enter${bits}. Open the call to confirm.`,
        type:    'entry_confirm',
        payload: { kind: 'call', callId: call?.id, asset: call?.asset, direction: call?.bias ?? null },
        botId:   'kairos',
    }
}

/** Kairos call thesis expiring ('edit' → re-map) or expired ('expired' → let it go / delete). */
export function buildCallExpiry(call, kind, why = null) {
    const content = kind === 'expired'
        ? `Kairos — ${call?.asset} thesis expired. Edit to re-map it or delete the call.`
        : `Kairos — ${call?.asset} thesis is expiring. Re-map it or let it go.`
    return {
        userId:  call?.user_id ?? null,
        content,
        type:    'call_expiry',
        payload: { callId: call?.id, asset: call?.asset, kind, why: why ?? null },
        botId:   'kairos',
    }
}

/** Kairos in-position MANAGEMENT proposal → open the call to accept/dismiss (Phase 5). */
export function buildCallManage(call, card) {
    const verb  = card?.verdict
    const asset = call?.asset
    const verbCopy = {
        move_stop:    'move the stop',
        take_partial: 'bank a partial',
        exit_now:     'exit now',
        let_run:      'let it run',
    }[verb] ?? 'manage the trade'
    return {
        userId:  call?.user_id ?? null,
        content: `Kairos — ${asset}: I want to ${verbCopy}. Open the call to accept or dismiss.`,
        type:    'call_manage',
        payload: { callId: call?.id, asset, verdict: verb ?? null, read: card?.read ?? null },
        botId:   'kairos',
    }
}

// ── Thin IO wrappers ────────────────────────────────────────────────────────────

async function _post(card, tag) {
    if (!card.userId) return null
    logger.info(LOG, `${tag} → user ${card.userId}: ${card.payload.asset}`)
    return sendBotMessage(card.userId, card.content, card.type, card.payload, card.botId)
}

export async function notifyIdeaEntryConfirm(idea, note = null) {
    return _post(buildIdeaEntryConfirm(idea, note), 'Entry-confirm card')
}

export async function notifyCallReady(call, assessment = null) {
    return _post(buildCallReady(call, assessment), 'Call-ready card')
}

export async function notifyCallExpiry(call, kind, why = null) {
    return _post(buildCallExpiry(call, kind, why), `Call-expiry card (${kind})`)
}

export async function notifyCallManage(call, card) {
    return _post(buildCallManage(call, card), `Call-manage card (${card?.verdict})`)
}

export const tradeNotifyService = { notifyIdeaEntryConfirm, notifyCallReady, notifyCallExpiry, notifyCallManage }
