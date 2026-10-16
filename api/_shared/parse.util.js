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
 * Validate + normalize a chat `messages` array, shared across every stream endpoint: each entry
 * must be an object with role user|assistant and a non-empty string content; content is trimmed
 * and NOTHING ELSE is kept — the client's own per-message fields (reasoning, charts, streaming
 * flags) stop here. Returns { messages } on success or { error } with a specific message.
 *
 * Callers forward `messages` from the result. Six of seven used to forward the raw body instead,
 * so the normalized array was computed and thrown away (the desks re-normalize, so nothing leaked
 * — but the parse existed for its output, not its verdict).
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
 * THE desk-turn request body, for every streaming desk: a validated conversation, the prior chat
 * state, the marked accounts, which one is main, and the model asked for. Returns `{ error }` for
 * anything a 400 should answer.
 *
 * MECHANISM ONLY — a desk's own extras (Mentor's `seed` and `clientTime`, Argus's modes, Atlas's
 * review flags) are read by that desk's `parse` in makeDeskStream, not here.
 *
 * The conversation is REQUIRED and non-empty: every client sends the whole history, and a headless
 * run that opens a desk on one sentence passes `openingTurn(text)` as its messages. There is no
 * second "prompt" field.
 *
 * Accounts keep only entries carrying an `id`: an id-less account would be rendered into a prompt as
 * a venue the desk could discuss and then silently dropped when it binds.
 *
 * The history is deliberately NOT capped here. That cap belongs to the agent
 * (agentUtils.normalizeMessages → trimHistory), which trims on a high-water mark so the cached
 * prompt prefix stays byte-stable; a slice() on every request is the sliding window that design
 * exists to avoid.
 *
 * @returns {{error: string} | {messages: object[], chatState: object|null, accounts: object[],
 *           mainAccountId: string|null, model: string|undefined}}
 */
export function parseDeskTurn(body) {
    const validated = parseChatMessages(body?.messages)
    if (validated.error) return { error: validated.error }

    // A chatState that is not a plain object is treated as NONE, never as a 400: four desks do not
    // read it at all, and refusing a whole turn over a field the desk would ignore (or rebuild from
    // its default) costs the user their message for nothing.
    const { chatState } = body
    const state = chatState && typeof chatState === 'object' && !Array.isArray(chatState) ? chatState : null

    return {
        messages:      validated.messages,
        chatState:     state,
        accounts:      parseIdeaAccounts(body.accounts),
        // Which marked account is starred main (bank icon). Normalized to string — it may arrive
        // as either, and every consumer compares it as one.
        mainAccountId: body.mainAccountId != null ? String(body.mainAccountId) : null,
        model:         typeof body.model === 'string' && body.model ? body.model : undefined,
    }
}
