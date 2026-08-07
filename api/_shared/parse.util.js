// Shared request-body parse helpers for the streaming chat endpoints.

const ALLOWED_MESSAGE_ROLES = new Set(['user', 'assistant'])

/**
 * Keep only well-formed idea-account entries (objects carrying an `id`).
 * Non-array input yields an empty array.
 */
export function parseIdeaAccounts(raw) {
    if (!Array.isArray(raw)) return []
    return raw.filter(a => a && typeof a === 'object' && a.id)
}

/**
 * Validate + normalize a chat `messages` array (the orchestrator's stricter
 * rules, shared across all three stream endpoints): each entry must be an object
 * with role user|assistant and a non-empty string content; content is trimmed.
 * Returns { messages } on success or { error } with a specific message.
 */
export function parseChatMessages(messages) {
    if (!Array.isArray(messages)) {
        return { error: 'messages must be an array' }
    }
    if (messages.length === 0) {
        return { error: 'messages must be a non-empty array' }
    }

    const normalized = []
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            return { error: `messages[${i}] must be an object with role and content` }
        }
        const { role, content } = msg
        if (!ALLOWED_MESSAGE_ROLES.has(role)) {
            return { error: `messages[${i}].role must be user or assistant` }
        }
        if (typeof content !== 'string' || !content.trim()) {
            return { error: `messages[${i}].content must be a non-empty string` }
        }
        normalized.push({ role, content: content.trim() })
    }

    return { messages: normalized }
}

/**
 * Browser-supplied local time ({ clientNow: ms, clientTz: IANA }) so a desk resolves "through
 * Friday" against the user's calendar and stores the bounds as absolute UTC. Each field is
 * validated independently — a bad value is dropped, never fatal. Returns null when neither
 * survives, which the prompt builders read as "timezone unknown, ask rather than guess"
 * (agentUtils.buildTimeSection).
 */
export function parseClientTime(body) {
    const now = Number(body?.clientNow)
    const tz  = typeof body?.clientTz === 'string' ? body.clientTz.trim() : ''
    const clientTime = {}
    if (Number.isFinite(now) && now > 0) clientTime.clientNow = now
    if (tz) clientTime.clientTz = tz
    return (clientTime.clientNow || clientTime.clientTz) ? clientTime : null
}

/**
 * THE agent-stream request body: a validated conversation, the prior chat state, the marked
 * accounts and which one is main. Returns `{ error }` for anything a 400 should answer.
 *
 * MECHANISM ONLY — per-desk extras (Kairos's Argus `seed`, Mentor's `clientTime`) stay with the
 * controller that owns them and are read there. Kairos and Mentor each carried a copy of this
 * function and had already drifted on the one judgment inside it: Kairos kept any object in
 * `accounts`, Mentor kept only those carrying an `id`. Mentor was right, and not just for tidiness
 * — `_finalizeCall` filters `id != null` before it binds, so an id-less account was rendered into
 * Kairos's prompt as a venue the desk could discuss and Generate would then silently drop.
 *
 * The history is deliberately NOT capped here. That cap belongs to the agent
 * (agentUtils.normalizeMessages → trimHistory), which trims on a high-water mark so the cached
 * prompt prefix stays byte-stable; a slice() on every request is the sliding window that design
 * exists to avoid.
 *
 * @returns {{error: string} | {chatState: object|null, accounts: object[], mainAccountId: string|null,
 *           messages?: object[], userPrompt?: string}}
 */
export function parseStreamBody(body) {
    const { messages, userPrompt, chatState, accounts } = body ?? {}
    const trimmedPrompt = typeof userPrompt === 'string' ? userPrompt.trim() : ''

    let state = null
    if (chatState !== undefined && chatState !== null) {
        if (typeof chatState !== 'object' || Array.isArray(chatState)) {
            return { error: 'chatState must be an object' }
        }
        state = chatState
    }

    const base = {
        chatState:     state,
        accounts:      parseIdeaAccounts(accounts),
        // Which marked account is starred main (bank icon). Normalized to string — it may arrive
        // as either, and every consumer compares it as one.
        mainAccountId: body?.mainAccountId != null ? String(body.mainAccountId) : null,
    }

    if (messages !== undefined && messages !== null) {
        if (!Array.isArray(messages)) return { error: 'messages must be an array' }
        // An empty array with a prompt to fall back on is fine; empty with nothing is not.
        if (messages.length === 0) {
            return trimmedPrompt
                ? { ...base, userPrompt: trimmedPrompt }
                : { error: 'messages must be a non-empty array' }
        }
        const validated = parseChatMessages(messages)
        if (validated.error) return { error: validated.error }
        return { ...base, userPrompt: trimmedPrompt || undefined, messages: validated.messages }
    }

    if (trimmedPrompt) return { ...base, userPrompt: trimmedPrompt }

    return { error: 'Request must include messages or userPrompt' }
}
