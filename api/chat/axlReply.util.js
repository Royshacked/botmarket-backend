// Pure helper for the Axl social-chat reply path. Maps a slice of stored chat
// messages (chronological, oldest→newest) into the {role, content} shape the
// agent services expect: the bot's own messages become 'assistant', everyone
// else's become 'user'. Non-text / empty messages are dropped so a notification
// card (invalidation_alert etc.) never reaches the model as a blank turn.
//
// Kept pure + DB-free so it's unit-testable (codebase convention: DB-touching
// modules aren't unit-tested; their pure helpers are).
export function toAgentMessages(messages, botId, maxCount = 12) {
    if (!Array.isArray(messages)) return []
    return messages
        .filter(m => m && typeof m.content === 'string' && m.content.trim())
        .map(m => ({
            role:    String(m.senderId) === String(botId) ? 'assistant' : 'user',
            content: m.content.trim(),
        }))
        .slice(-maxCount)
}
