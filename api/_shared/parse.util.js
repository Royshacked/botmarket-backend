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
