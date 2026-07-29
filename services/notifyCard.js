import { postBotCard } from '../api/chat/chat.service.js'
import { logger } from './logger.service.js'

// The one way a card reaches the user.
//
// Three modules posted bot cards and each had its own wrapper with DIFFERENT failure semantics:
// coverageNotify caught and swallowed, tradeNotify logged but let the error propagate, and
// manualNotify called postBotCard bare. Callers then compensated inconsistently — some wrapped
// the call in try/catch, some didn't.
//
// THE RULE, and why it is not a style preference: a card is an ALERT ABOUT a state change, never
// part of it. By the time we post, the state has already been written — an idea is 'hit', a
// position is 'awaiting_manual_close'. If delivery throws back into that caller it cannot undo the
// write, so all it can do is abort the rest of the handler and, in the worst case, leave a
// persisted guard that suppresses every retry. That is exactly how a manual exit could end up
// marked "awaiting user close" with no card ever delivered and no second attempt.
//
// So posting NEVER throws. A failure is warn-logged and returns null; the caller carries on.

/**
 * Post a bot card. Never throws.
 *
 * @param {object|null} card  { userId, content, type, payload, botId, actions }
 * @param {{ tag: string, log: string }} ctx  `tag` names the card in logs; `log` is the module tag
 * @returns {Promise<object|null>} the posted message, or null when skipped or failed
 */
export async function postCard(card, { tag = 'Card', log = '[notify]' } = {}) {
    // No owner → nowhere to deliver. Not an error: a builder returns a card with a null userId for
    // an entity that has lost its user, and the callers treat null as "nothing posted".
    if (!card?.userId) return null
    try {
        logger.info(log, `${tag} → user ${card.userId}`)
        return await postBotCard(card)
    } catch (err) {
        logger.warn(log, `${tag} failed for user ${card.userId}:`, err.message)
        return null
    }
}
