// Card rows in the session timeline — the READ side only.
//
// Desk cards live in the social chat. Phase 6 also mirrored every desk card into the user's live session as a
// REFERENCE row (`{ agent, kind: 'card', content, ref: { msgId, conversationId, type, subject, action } }`);
// Roy reverted that on 2026-10-18 — review cards are acted on from the social chat, as before. Nothing
// writes a card row any more; this module only draws the rows already in a timeline, from the card store,
// so their state stays the card's own.

import { cardsById } from '../api/chat/chat.service.js'

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
