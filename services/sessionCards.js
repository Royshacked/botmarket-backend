// Background desk cards in the live session (unified-chat plan phase 6, decision 15).
//
// Every desk card postBotCard writes is also placed in the user's live session timeline — as a REFERENCE
// to the card row, not a copy (H1): `{ agent, kind: 'card', content, ref: { msgId, conversationId, type,
// subject, action } }`. The card store stays the one record; its live state (pending / done / dismissed /
// superseded) moves by the same `message_resolved` frame the social chat already gets, matched on msgId.
//
//   who        the desk the card speaks for (agentOfBot) — Talos posts as Mentor, Themis as Atlas, the
//              coverage monitor as Prometheus; the archived calls' cards (botId `kairos`) read as Axl
//   where      that agent's scope — Pythia's cards in the admin's `strategy` session, the rest in `main`;
//              only a session the user ALREADY has (H3): no session is created for a card
//   what       cardAction — the ONE table of what the card's button does from the timeline: open a dialog,
//              edit an entity (the session edit route), the brief, an inline form, or nothing
//
// Registered on chat.service's onCardPosted at boot; a failure here never fails the post.

import { onCardPosted, cardsById } from '../api/chat/chat.service.js'
import { sessionService } from './session.service.js'
import { deskOf } from './desks/registry.js'

/** The session agent a card speaks for. Unknown and retired bots read as Axl. */
export function agentOfBot(botId) {
    return deskOf(botId) ? botId : 'axl'
}

/**
 * What the card's button does from the timeline — the client draws the button from this and never decides
 * it a second time. Read from the card's type and payload.
 *   { type: 'dialog', event, ids }   the client's existing confirm doorway (an order, a setup, the queue)
 *   { type: 'popup', kind, id }      the entity's own pop-out (a manage verdict)
 *   { type: 'edit', kind, id, ... }  reopen it in the session (POST /api/sessions/:id/edit)
 *   { type: 'brief', day }           today's market brief, delivered as Axl's turn
 *   { type: 'navigate', to }         a page of the app (the forecasts map)
 *   { type: 'form' }                 the card carries its own form (a manual fill) — it acts inline
 *   { type: 'none' }                 nothing to do but read it
 */
export function cardAction(msg) {
    const p = msg?.payload ?? {}
    switch (msg?.type) {
        case 'entry_confirm':
            if (p.setupId) return { type: 'dialog', event: 'SETUP_CONFIRM_OPEN', ids: { setupId: p.setupId } }
            if (p.ideaId)  return { type: 'dialog', event: 'ENTRY_CONFIRM_OPEN', ids: { ideaId: p.ideaId } }
            return { type: 'none' }   // a call's confirm surface was archived with Kairos
        case 'queue_ready':        return { type: 'dialog', event: 'OPEN_QUEUED_LIST', ids: {} }
        case 'setup_invalidation': return msg.actions && p.setupId ? { type: 'edit', kind: 'setup', id: p.setupId } : { type: 'none' }
        case 'setup_manage':
            if (!p.setupId) return { type: 'none' }
            return p.verdict === 'add_leg'
                ? { type: 'dialog', event: 'SETUP_CONFIRM_OPEN', ids: { setupId: p.setupId } }
                : { type: 'popup', kind: 'setup', id: p.setupId }
        case 'manual_entry':
        case 'manual_exit':        return { type: 'form' }
        case 'coverage_event':     return p.coverageId ? { type: 'edit', kind: 'coverage', id: p.coverageId } : { type: 'none' }
        case 'coverage_refreshed':
            if (p.portfolioId) return { type: 'edit', kind: 'portfolio', id: p.portfolioId, reviewMode: true }
            return p.coverageId ? { type: 'edit', kind: 'coverage', id: p.coverageId } : { type: 'none' }
        case 'portfolio_review':   return p.portfolioId ? { type: 'edit', kind: 'portfolio', id: p.portfolioId, reviewMode: true } : { type: 'none' }
        case 'sleeve_sourced':     return p.portfolioId ? { type: 'edit', kind: 'portfolio', id: p.portfolioId } : { type: 'none' }
        case 'market_brief_offer': return { type: 'brief', day: p.day ?? null }
        case 'industry_view':      return { type: 'navigate', to: 'forecasts' }
        default:                   return { type: 'none' }
    }
}

/**
 * What a card row is drawn from on the client (plan phase 7, J3): the card's own payload, actions and state.
 * The row stays a reference (H1); this view is attached on every READ and push, never stored.
 */
export function cardView(msg) {
    if (!msg) return null
    return { payload: msg.payload ?? null, actions: msg.actions ?? null, status: msg.status ?? null, resolveOutcome: msg.resolveOutcome ?? null, resolveNote: msg.resolveNote ?? null }
}

/**
 * Attach `card` to every card row, from one read of the card store — the messages route and the reconnect
 * replay. A card that is gone reads `card: null`; every other row is returned as it was.
 */
export async function hydrateCards(rows, read = cardsById) {
    const refs = (rows ?? []).filter(r => r?.kind === 'card' && r.ref?.msgId).map(r => ({ msgId: r.ref.msgId, conversationId: r.ref.conversationId }))
    if (!refs.length) return rows ?? []
    const byId = await read(refs)
    return rows.map(r => (r?.kind === 'card' ? { ...r, card: cardView(byId.get(String(r.ref?.msgId))) } : r))
}

/** The hook postBotCard calls after a desk card is written. Exported for tests. */
export async function mirrorCard({ userId, botId, msg }, store = sessionService) {
    const agent   = agentOfBot(botId)
    const scope   = deskOf(agent)?.scope ?? 'main'
    const session = await store.findActive({ userId, scope })
    if (!session) return null
    return store.append({ sessionId: session.sessionId, userId, live: { card: cardView(msg) }, message: {
        agent, role: 'assistant', kind: 'card', content: msg.content ?? '',
        ref: { msgId: msg.id, conversationId: msg.conversationId, type: msg.type, subject: msg.subject ?? null, action: cardAction(msg) },
    } })
}

// The hook is fire-and-forget, so two cards posted together would race to the timeline. One tail per user
// keeps them in post order; a failed mirror does not block the next. The entry goes when its tail drains.
const _tails = new Map()
export function mirrorInOrder(args, mirror = mirrorCard) {
    const key  = String(args.userId)
    const run  = (_tails.get(key) ?? Promise.resolve()).then(() => mirror(args))
    const tail = run.catch(() => {}).finally(() => { if (_tails.get(key) === tail) _tails.delete(key) })
    _tails.set(key, tail)
    return run
}

/** Register the hook. Called once at startup (server.js). */
export function registerSessionCards() {
    onCardPosted((args) => mirrorInOrder(args))
}
