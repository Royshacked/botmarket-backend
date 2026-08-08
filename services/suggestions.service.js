// Follow-up SUGGESTIONS — the shared pipe for "what might I ask next", offered as chips under an
// agent's reply.
//
// SHARED: the tag, the collection, the cleaning, the caps. Every agent that offers suggestions
// gets the same wire format and the same guarantees, so the client renders one thing.
//
// NOT SHARED: what to suggest. That is judgment, and it belongs to the desk — Axl's good follow-up
// ("run the review that is overdue") is nothing like Prometheus's ("re-model on the new guidance").
// A single "suggestion generator" service would be the cross-desk unifier the house rule forbids.
// So this file has no opinion about content; each agent's prompt authors its own.
//
// COSTS NOTHING EXTRA. The suggestions ride out inside the reply the agent is already streaming, as
// `<suggest>…</suggest>` tags. A second model call to "generate follow-ups" would double the
// round-trip on every turn, which for a concierge meant to feel instant is the wrong trade.

/** The emit tag. Must also appear in ALL_EMIT_TAGS or it is printed at the user, not captured. */
export const SUGGEST_TAG = 'suggest'

/**
 * Three, hard. Two or three read as an offer; six reads as a menu, and menus do not get read. The
 * cap lives here rather than in a prompt because a prompt is a request and this is a guarantee.
 */
export const MAX_SUGGESTIONS = 3

/** Long enough for a real question, short enough to stay on one chip. */
const MAX_LENGTH = 80

/**
 * Clean one captured suggestion, or null if it is not worth showing.
 *
 * Models like to decorate a list even when asked not to, so leading bullets and numbering are
 * stripped rather than trusted away. Anything still empty afterwards is dropped silently: a blank
 * chip is worse than one fewer chip.
 */
function _clean(text) {
    const s = String(text ?? '')
        .replace(/\s+/g, ' ')
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')   // "1. " / "- " / "• "
        .replace(/^["'“”]|["'“”]$/g, '')            // stray wrapping quotes
        .trim()
    if (!s) return null
    if (s.length > MAX_LENGTH) return null          // truncating a question makes it a different one
    return s
}

/**
 * Normalize everything an agent emitted this turn into what the client renders.
 *
 * @param {string[]} captured  raw <suggest> bodies, in the order they appeared
 * @returns {string[]}         cleaned, de-duplicated, capped
 */
export function normalizeSuggestions(captured = []) {
    const seen = new Set()
    const out  = []
    for (const raw of captured) {
        const s = _clean(raw)
        if (!s) continue
        // Case-insensitive dedupe: two chips that differ only in capitalisation are one chip that
        // renders twice, which reads as a bug.
        const key = s.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(s)
        if (out.length === MAX_SUGGESTIONS) break
    }
    return out
}

/**
 * The one-line wiring an agent needs. Returns the capture callback to hand `buildTagCaptures`,
 * and a getter for the finished list.
 *
 *   const suggest = makeSuggestionCapture()
 *   … buildTagCaptures({ suggest: suggest.onCapture })
 *   … return { suggestions: suggest.result() }
 */
export function makeSuggestionCapture() {
    const captured = []
    return {
        onCapture: (text) => { captured.push(text) },
        result:    () => normalizeSuggestions(captured),
    }
}

export const suggestionsService = { SUGGEST_TAG, MAX_SUGGESTIONS, normalizeSuggestions, makeSuggestionCapture }
