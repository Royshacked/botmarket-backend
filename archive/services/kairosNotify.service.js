/**
 * Kairos card builders — ARCHIVED with the desk (2026-09-15; the desk itself 2026-08-18).
 *
 * The four social-chat cards Hermes posted about a `call`: ready-to-enter, thesis expiry, an
 * in-position management proposal, and a re-entry offer after a stop-out. They lived in
 * services/tradeNotify.service.js beside the live idea/setup builders and were still exported and
 * unit-tested there a month after their only callers (hermes.monitor.service, kairos.handoff) moved
 * here — dead in the live tree, kept green by tests that pinned copy nothing renders.
 *
 * Same shape as the live builders: a pure builder returning `{ userId, content, type, payload,
 * botId, actions }`, and a thin wrapper handing it to the shared card pipe. Revive by moving the
 * builders back into tradeNotify (or a kairosNotify beside it) and re-registering the `kairos` bot.
 */

import { cardActions } from '../../api/chat/chat.service.js'
import { postCard }    from '../../services/notifyCard.js'

const LOG = '[kairosNotify]'

/** Kairos call READY to enter → open the call to confirm. Proposal comes from the fresh assessment. */
export function buildCallReady(call, assessment = null) {
    // Only show the price bits when BOTH numbers finalized — _finalizeProposal returns null for
    // entry/stop it can't resolve, and "entry null, stop null" must never reach the card copy.
    const p       = assessment?.proposal
    // NB: Number.isFinite (no coercion) — Number(null) is 0 (finite), which would leak "stop null".
    const hasNums = p && Number.isFinite(p.entry) && Number.isFinite(p.stop)
    const bits    = hasNums ? ` (entry ${p.entry}, stop ${p.stop})` : ''
    return {
        userId:  call?.userId ?? null,
        content: `Kairos — ${call?.asset} is ready to enter${bits}. Open the call to confirm.`,
        type:    'entry_confirm',
        payload: { kind: 'call', callId: call?.id, asset: call?.asset, direction: call?.bias ?? null },
        botId:   'kairos',
        actions: cardActions('Open the call'),
    }
}

/**
 * Kairos call thesis went stale: `kind` is 'edit' (re-map it) or 'expired' (let it go / delete).
 * NB `kind` is this CARD's parameter, not the call's status — a stale thesis is the invalidation
 * axis; the call itself stays 'looking' until the user acts.
 */
export function buildCallExpiry(call, kind, why = null) {
    const content = kind === 'expired'
        ? `Kairos — ${call?.asset} thesis expired. Edit to re-map it or delete the call.`
        : `Kairos — ${call?.asset} thesis is expiring. Re-map it or let it go.`
    return {
        userId:  call?.userId ?? null,
        content,
        type:    'call_expiry',
        payload: { callId: call?.id, asset: call?.asset, kind, why: why ?? null },
        botId:   'kairos',
        actions: cardActions('Edit call'),
    }
}


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
        userId:  call?.userId ?? null,
        content: `Kairos — ${asset}: I want to ${verbCopy}. Open the call to accept or dismiss.`,
        type:    'call_manage',
        payload: { callId: call?.id, asset, verdict: verb ?? null, read: card?.read ?? null },
        botId:   'kairos',
        actions: cardActions('Review'),
    }
}

/**
 * Kairos position STOPPED OUT but the thesis still looks intact → offer a re-entry. Routes to the
 * call pop-out, where the user picks Re-enter (revive the call, re-arm the plan) or Close (leave it
 * terminal). `read` carries the thesis-check rationale; `outcome` the stop-out (exit price / R).
 */
export function buildCallReentry(call, read = null, outcome = null) {
    const asset   = call?.asset
    const px      = outcome?.exit_price
    const stopBit = Number.isFinite(px) ? ` at ${px}` : ''
    const why     = read?.why ? ` ${read.why}` : ''
    return {
        userId:  call?.userId ?? null,
        content: `Kairos — ${asset} stopped out${stopBit}, but the thesis still looks intact.${why} Re-enter or close it out?`,
        type:    'call_reentry',
        payload: { callId: call?.id, asset, exit_price: Number.isFinite(px) ? px : null, why: read?.why ?? null },
        botId:   'kairos',
        actions: cardActions('Review re-entry'),
    }
}

// ── Thin IO wrappers ────────────────────────────────────────────────────────────

const _post = (card, tag) => postCard(card, { tag, log: LOG })

export async function notifyCallReady(call, assessment = null) {
    return _post(buildCallReady(call, assessment), 'Call-ready card')
}

export async function notifyCallExpiry(call, kind, why = null) {
    return _post(buildCallExpiry(call, kind, why), `Call-expiry card (${kind})`)
}

export async function notifyCallManage(call, card) {
    return _post(buildCallManage(call, card), `Call-manage card (${card?.verdict})`)
}

export async function notifyCallReentry(call, read = null, outcome = null) {
    return _post(buildCallReentry(call, read, outcome), 'Call-reentry card')
}
