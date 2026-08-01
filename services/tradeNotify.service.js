/**
 * Confirm-entry + Kairos-call notifications to social chat.
 *
 * "Major event" cards posted through the same bot-card channel as invalidation_alert /
 * manualNotify (postBotCard → chat_messages → WS). These are NOTIFY-AND-ROUTE cards: the
 * card is the alert + a clickable preview; the existing action UI is where the user actually
 * acts (paper/live entry → OrderConfirmDialog; a Kairos call → its pop-out detail window, which
 * hosts Confirm-entry / Accept-edit / Delete).
 *
 * Manual-mode fills keep their own inline FillCard (manualNotify) — this covers the two gaps:
 * paper/live entry confirmation (was a silent modal) and Kairos readiness/expiry (was a poll
 * card + a silent terminal expiry).
 *
 * Shape is split into pure builders (unit-tested — the { userId, content, type, payload, botId,
 * actions } a card sends) and thin async wrappers that hand the builder's output to postBotCard.
 */

import { cardActions } from '../api/chat/chat.service.js'
import { postCard } from './notifyCard.js'

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
        actions: cardActions('Confirm order'),
    }
}

/**
 * A `setup` reached one of its entry zones → confirm to place the order.
 *
 * Its own builder rather than a reuse of buildIdeaEntryConfirm: that one's `note` is a
 * three-value enum the copy branches on, so passing Talos's free-text warning through it would
 * silently swallow the warning. Shared TRANSPORT (postBotCard + cardActions), own COPY — the
 * house rule.
 *
 * This fires ONLY on an `enter` verdict — a fulfilled setup, not merely a tripped zone. A card
 * that arrives is therefore never hedged: there is no "but Talos flags…" variant, because a setup
 * Talos declined never gets here (it stays 'looking' instead). `read` carries Talos's one-line
 * monologue for the card body; the copy leads with the SETUP being confirmed, not the zone, since
 * the zone alone was never what the user is being asked about.
 */
export function buildSetupEntryConfirm(setup, assessment = null) {
    const dir = String(setup?.direction || '').toUpperCase()
    return {
        userId:  setup?.userId ?? null,
        content: `Your ${dir} ${setup?.asset} setup is confirmed — price reached the zone and the setup filled in. Confirm to place your order.`,
        type:    'entry_confirm',
        payload: {
            kind:      'setup',
            setupId:   setup?.id,
            asset:     setup?.asset,
            direction: setup?.direction ?? null,
            zoneId:    assessment?.zone_id ?? setup?.armed_zone_id ?? null,
            verdict:   assessment?.verdict ?? null,
            read:      assessment?.read ?? null,
        },
        botId:   'mentor',
        actions: cardActions('Confirm order'),
    }
}

/**
 * The setup's plan is no longer worth what it was — either price left the validity range, or Talos
 * read the map as stale. FOUR distinct messages, because they are four different things to hear and
 * merging them would produce copy that is wrong for three of the four:
 *
 *   ran_away        price left on the FAVOURABLE side. Nothing was wrong with the read — it was
 *                   missed. Not a problem to solve, so no action button; a chase is the user's own
 *                   decision to make from a clean slate.
 *   invalidated     the premise broke and the user asked to be given the chance to re-draw it.
 *   invalidated_fyi same break, but they chose notify_only — tell them, ask nothing.
 *   stale_map       Talos's own read: the levels have drifted from where structure now sits. This
 *                   one carries the proposal, so it is the only one that can offer a re-map.
 *
 * The transport is shared (_post → the one card pipe); the wording is Mentor's.
 */
export function buildSetupInvalidation(setup, info = null) {
    const dir   = String(setup?.direction || '').toUpperCase()
    const asset = setup?.asset ?? 'your setup'
    const kind  = info?.card ?? 'invalidated'
    const why   = info?.reason ?? null

    const copy = {
        ran_away: {
            content: `Your ${dir} ${asset} setup didn't get filled — price ran past ${info?.price ?? 'the level'} without you. Nothing was wrong with the read; the entry just never came.`,
            actions: null,
        },
        invalidated: {
            content: `Your ${dir} ${asset} setup is no longer valid — price closed at ${info?.price ?? '?'}, past the ${info?.edge ?? 'edge'} of where this trade works. Want to re-draw it?`,
            actions: cardActions('Re-draw it'),
        },
        invalidated_fyi: {
            content: `Heads up — your ${dir} ${asset} setup is no longer valid. Price closed at ${info?.price ?? '?'}, past the ${info?.edge ?? 'edge'} of where this trade works.`,
            actions: null,
        },
        stale_map: {
            content: `Your ${dir} ${asset} setup needs re-drawing — ${why || 'the levels have drifted from where structure sits now'}.`,
            actions: cardActions('Re-draw it'),
        },
    }[kind] ?? { content: `Your ${dir} ${asset} setup needs a look.`, actions: null }

    return {
        userId:  setup?.userId ?? null,
        content: copy.content,
        type:    'setup_invalidation',
        payload: {
            kind:      'setup',
            setupId:   setup?.id,
            asset:     setup?.asset,
            direction: setup?.direction ?? null,
            event:     kind,
            side:      info?.side ?? null,
            edge:      info?.edge ?? null,
            price:     Number.isFinite(info?.price) ? info.price : null,
            reason:    why,
            ...(info?.edit_proposal ? { edit_proposal: info.edit_proposal } : {}),
        },
        botId:   'mentor',
        ...(copy.actions ? { actions: copy.actions } : {}),
    }
}

/**
 * SEVERAL orders came off the bench at once — the market opened on a batch that had parked
 * overnight (a portfolio activation is the usual case: nine holdings, nine deferred plans).
 *
 * ONE card, not N. Nine separate confirm cards at 09:30 is not nine notifications, it is a wall
 * the user scrolls past — and the confirm dialog already walks a queue one order at a time, so the
 * card only has to get them INTO that queue.
 *
 * Grouped per KIND, never across kinds: the batch still belongs to the desk that authored it, and
 * one cross-kind "all your orders" card would be exactly the notification router that was
 * deliberately abandoned (see project_axl_agent). So `botId` and the route target are passed in by
 * the caller that owns the kind; the SENTENCE is shared because the event genuinely is one event —
 * the market opened — and there is no per-desk judgment in saying so.
 *
 * `staleHours` is the age of the OLDEST plan in the batch. Surfaced rather than acted on: these
 * plans were priced before the close, and the user decides whether that still stands (the confirm
 * dialog shows the same age). Omitted when nothing in the batch is old enough to be worth saying.
 */
export function buildOrdersReady({ userId, entities = [], kind, botId, staleHours = null }) {
    const n      = entities.length
    const assets = [...new Set(entities.map(e => e?.asset).filter(Boolean))]
    // Name them when the list is short enough to read; past that the count is the information.
    const names  = assets.length && assets.length <= 4 ? ` (${assets.join(', ')})` : ''
    const stale  = Number.isFinite(staleHours) && staleHours >= 12
        ? ` These were priced ${Math.round(staleHours)}h ago, before the close — check the levels still make sense.`
        : ''
    return {
        userId: userId ?? null,
        content: `The market is open — ${n} order${n === 1 ? '' : 's'}${names} ${n === 1 ? 'is' : 'are'} ready to place.${stale} Confirm them one at a time.`,
        type:    'orders_ready',
        payload: {
            kind,
            count: n,
            assets,
            // The queue's entry point. The confirm dialog surfaces the first eligible order by
            // itself; this just opens it on the right workspace.
            firstId: entities[0]?.id ?? null,
            staleHours: Number.isFinite(staleHours) ? Math.round(staleHours) : null,
        },
        botId,
        actions: cardActions('Review orders'),
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

// Delegates to the shared poster, which NEVER throws — these cards are posted AFTER the state
// change they announce, so a delivery failure must not abort the caller's remaining work.
const _post = (card, tag) => postCard(card, { tag, log: LOG })

export async function notifyIdeaEntryConfirm(idea, note = null) {
    return _post(buildIdeaEntryConfirm(idea, note), 'Entry-confirm card')
}

export async function notifySetupEntryConfirm(setup, assessment = null) {
    return _post(buildSetupEntryConfirm(setup, assessment), 'Setup entry-confirm card')
}

export async function notifyOrdersReady(batch) {
    return _post(buildOrdersReady(batch), `Orders-ready card (${batch?.entities?.length ?? 0})`)
}

export async function notifySetupInvalidation(setup, info = null) {
    return _post(buildSetupInvalidation(setup, info), `Setup-invalidation card (${info?.card ?? '?'})`)
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

export async function notifyCallReentry(call, read = null, outcome = null) {
    return _post(buildCallReentry(call, read, outcome), 'Call-reentry card')
}

export const tradeNotifyService = { notifyIdeaEntryConfirm, notifySetupEntryConfirm, notifySetupInvalidation, notifyOrdersReady, notifyCallReady, notifyCallExpiry, notifyCallManage, notifyCallReentry }
