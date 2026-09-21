import { logger }         from '../../services/logger.service.js'
import { toBlueprint }    from '../../services/setup.blueprint.js'
import { fetchLastPrice } from '../../services/lastPrice.service.js'
import { postUserCard, cardActions } from '../chat/chat.service.js'
import { userService }    from '../user/user.service.js'
import { setupService }   from './setups.service.js'

// Sharing a setup — one user's plan, sent to another as a card in a social-chat DM.
//
// Its own module, beside setups.service rather than inside it, for a reason that is load order and
// not taste: this is the one setup move that reaches the CHAT pipe, and chat.service pulls in the
// Axl agent, whose tools read the setups list. Importing the pipe from setups.service closed that
// loop and every module on it woke up in a TDZ. The controller is the only importer here, which is
// where a route-level composition of two services belongs anyway.
//
// Judgment lives here (what a shared setup contains); the pipe is chat's `postUserCard`.

const LOG = '[setups:share]'

/** The card type a shared setup arrives as. The frontend's ChatWindow switch keys on it. */
export const SETUP_SHARED_TYPE = 'setup_shared'
/** A sender's note is a line, not a letter. */
export const SHARE_NOTE_MAX = 500

// The four reaches — the owned read, the chat pipe, a quote, the users collection — seamed so what
// a shared card carries can be asserted without any of them. Resolved at call time, not at load.
const _deps = { getSetup: null, postCard: null, lastPrice: null, sender: null }
const _live = () => ({
    getSetup:  _deps.getSetup  ?? setupService.getSetup,
    postCard:  _deps.postCard  ?? postUserCard,
    lastPrice: _deps.lastPrice ?? fetchLastPrice,
    sender:    _deps.sender    ?? userService.getUserById,
})
/** Test-only. Returns a restore fn. */
export function _setDeps(overrides = {}) {
    const prev = { ..._deps }
    Object.assign(_deps, overrides)
    return () => Object.assign(_deps, prev)
}

/**
 * Send one of the user's setups to another user, as a card in a social-chat DM they share.
 *
 * What travels is the BLUEPRINT (services/setup.blueprint) — the plan, with the size, the account,
 * the mode, the status and every monitor field stripped — plus the sender's note and the price at
 * the moment of sending, so the recipient can see how far the tape has moved before Mentor re-reads
 * it. The copy is a FORK: the blueprint rides inline in the card, so revising or deleting this
 * document afterwards changes nothing for the recipient, and `from` is provenance only.
 *
 * The payload deliberately keys the origin as `source_setup_id`, NOT `setupId`: `setupId` is a
 * `cardSubject` key, and a subject would make the recipient's card close on the SENDER's next
 * write to their own document.
 *
 * A failed price read never blocks the send — `drawn_price: null` and the card still goes.
 *
 * Returns `{ ok, message }` or `{ ok:false, reason }` (`not_found` / `forbidden` from the crud,
 * `bot_recipient` / `forbidden` from the chat pipe).
 */
export async function shareSetup(id, userId, { conversationId, note = null } = {}) {
    if (typeof conversationId !== 'string' || !conversationId.trim()) return { ok: false, reason: 'invalid_conversation' }
    const { getSetup, postCard, lastPrice } = _live()

    const found = await getSetup(id, userId)
    if (!found.ok) return found
    const setup = found.doc

    const from  = await _senderProvenance(userId)
    const bp    = toBlueprint(setup, { at: Date.now(), from })
    const price = await Promise.resolve().then(() => lastPrice(setup.asset)).catch(err => {
        logger.warn(LOG, `no price for ${setup.asset} (card still posted)`, err?.message ?? err)
        return null
    })

    const text = typeof note === 'string' ? note.trim().slice(0, SHARE_NOTE_MAX) : ''
    const line = `Shared a ${setup.asset} ${setup.direction ?? ''} setup`.replace(/\s+/g, ' ').trim()

    const res = await postCard({
        conversationId: conversationId.trim(),
        senderId:       userId,
        type:           SETUP_SHARED_TYPE,
        content:        text || line,
        payload: {
            blueprint:       bp,
            note:            text || null,
            drawn_price:     Number.isFinite(price) && price > 0 ? price : null,
            rr:              Number.isFinite(setup.rr) ? setup.rr : null,
            source_setup_id: setup.id,
        },
        // Resolves on OPEN: the ask is "look at this", and looking is the recipient's whole
        // obligation — sizing and generating are their own decision, not this card's job.
        actions: cardActions('Open in Mentor', { resolvesOn: 'open' }),
    })
    if (!res.ok) return res
    logger.info(LOG, `shared setup ${setup.id} into ${conversationId}`)
    return res
}

/**
 * Whose plan this is, for the recipient's eyes. The users collection is the source of the display
 * name; a lookup that fails (a deleted account mid-flight) still names the id, because a blueprint
 * without a `from` is a plan of unknown origin, which is the one thing a recipient must never see.
 */
async function _senderProvenance(userId) {
    try {
        const u = await _live().sender(userId)
        return { userId: String(userId), username: u?.username ?? null, fullname: u?.fullname ?? null }
    } catch {
        return { userId: String(userId), username: null, fullname: null }
    }
}
