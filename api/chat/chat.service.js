import { getDb, stripId }  from '../../providers/mongodb.provider.js'
import { logger } from '../../services/logger.service.js'
import { axlAgentService } from '../../services/axl.agent.service.js'
import { resolveModel }    from '../../services/modelRouter.service.js'
import { toAgentMessages } from './axlReply.util.js'

const LOG   = '[chat]'
const CONVS = 'chat_conversations'
const MSGS  = 'chat_messages'

export const BOT_USER_ID = 'axl'   // the default + the one conversational bot
// One notification bot per agent (ids are the canonical agent keys). Each producer
// posts under its authoring agent so the social-chat conversation sender matches the
// card's agent tag — a portfolio review reads "from Atlas", an invalidation "from Idea".
// The specialist threads are notify-only feeds; only Axl handles replies.
export const BOT_IDS = ['axl', 'idea', 'portfolio', 'scanner', 'kairos']
export const isBot = (id) => BOT_IDS.includes(String(id))
const BOT_WELCOME = "Hi, I'm Axl — your trading assistant. I'll notify you here about portfolio reviews, position alerts, and anything that needs your attention, and you can ask me how the app works. Just message me."

// Lazy import to avoid circular dependency (chatWs imports nothing from here).
// emit is only called at runtime, never at module-load time.
let _emit = null
async function _tryEmit(userId, event, data) {
    if (!_emit) {
        try { _emit = (await import('./chatWs.js')).emit } catch { /* ws not attached yet */ }
    }
    _emit?.(userId, event, data)
}

export async function ensureIndexes() {
    try {
        const db = await getDb()
        await db.collection(CONVS).createIndexes([
            { key: { participants: 1 } },
            { key: { participants: 1, lastMessageAt: -1 } },
        ])
        await db.collection(MSGS).createIndexes([
            { key: { conversationId: 1, createdAt: -1 } },
            { key: { conversationId: 1, readAt: 1 } },
        ])
    } catch (err) {
        logger.warn(LOG, 'ensureIndexes failed', err.message)
    }
}

/**
 * Find or create a DM conversation between two participants.
 * Participants are sorted before storage so [a,b] and [b,a] resolve to the same doc.
 * Returns { conv, created }.
 */
export async function getOrCreateConversation(userIdA, userIdB) {
    const db           = await getDb()
    const participants = [String(userIdA), String(userIdB)].sort()

    const existing = await db.collection(CONVS).findOne({ participants })
    if (existing) return { conv: stripId(existing), created: false }

    const conv = {
        id:            `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        participants,
        createdAt:     Date.now(),
        lastMessageAt: Date.now(),
        lastMessage:   '',
    }
    await db.collection(CONVS).insertOne(conv)
    return { conv: stripId(conv), created: true }
}

export async function sendMessage(conversationId, senderId, content, type = 'text', payload = null) {
    const db  = await getDb()
    const msg = {
        id:             `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        conversationId,
        senderId:       String(senderId),
        content,
        type,
        payload:        payload ?? null,
        createdAt:      Date.now(),
        readAt:         null,
    }
    await db.collection(MSGS).insertOne(msg)
    await db.collection(CONVS).updateOne(
        { id: conversationId },
        { $set: { lastMessageAt: msg.createdAt, lastMessage: String(content).slice(0, 120) } }
    )
    return stripId(msg)
}

/**
 * The single function all platform features call to notify a user from the bot.
 * Writes to DB then pushes a WS event to the user if they are connected.
 */
export async function sendBotMessage(userId, content, type = 'text', payload = null, botId = BOT_USER_ID) {
    try {
        const bot = isBot(botId) ? String(botId) : BOT_USER_ID
        const { conv } = await getOrCreateConversation(userId, bot)
        const msg = await sendMessage(conv.id, bot, content, type, payload)
        await _tryEmit(String(userId), 'new_message', msg)
        return msg
    } catch (err) {
        logger.error(LOG, 'sendBotMessage failed', err)
        return null
    }
}

/**
 * Generate Axl's reply to a user message in the social chat and send it back.
 * Called (fire-and-forget) after a user posts into their Axl conversation.
 *
 * Role #1 of the Axl agent: the social-chat assistant. Non-streaming — it collects
 * the full reply and pushes it as a single bot message (the social chat is WS
 * push, not SSE). Routing to specialists + thread resolution are later layers;
 * for now Axl answers general / app-guide questions itself and, per its prompt,
 * routes any build/change request to the relevant specialist chat.
 *
 * `aiPref` ({ routingMode, model, reasoningEffort }) is the user's shared AI-mode
 * setting, forwarded by the social-chat client so Axl obeys the same model routing
 * as Idea/Atlas/Argus. Resolved via the shared modelRouter (agent 'axl' is
 * phaseless → auto/classifier fall back to the default route; manual honours the
 * picked model + reasoning).
 */
export async function triggerAxlReply(userId, conversationId, aiPref = {}) {
    try {
        const history = await getMessages(conversationId, userId, null, 12)
        if (!history || !history.length) return

        const agentMessages = toAgentMessages(history, BOT_USER_ID, 12)
        // Only answer when the latest turn is actually the user's (guards against
        // a race where the trigger fires but the newest message is Axl's own).
        if (agentMessages.at(-1)?.role !== 'user') return

        const { routingMode, model, reasoningEffort } = aiPref
        const lastMessage = agentMessages.at(-1)?.content ?? ''
        const routing = await resolveModel({ routingMode, agent: 'axl', phase: null, model, reasoningEffort, lastMessage })

        const { reply } = await axlAgentService.chatStream({
            messages:        agentMessages,
            model:           routing.model,
            reasoningEffort: routing.reasoningEffort,
            userId,
        })
        if (reply?.trim()) await sendBotMessage(userId, reply.trim())
    } catch (err) {
        logger.error(LOG, 'triggerAxlReply failed', err)
    }
}

/**
 * Seed the bot conversation for a new user. Idempotent — safe to call multiple times.
 */
export async function seedBotConversation(userId) {
    const { conv, created } = await getOrCreateConversation(userId, BOT_USER_ID)
    if (created) await sendMessage(conv.id, BOT_USER_ID, BOT_WELCOME)
}

export async function getConversations(userId) {
    const db  = await getDb()
    const uid = String(userId)

    const convs = await db.collection(CONVS)
        .find({ participants: uid })
        .sort({ lastMessageAt: -1 })
        .toArray()

    if (!convs.length) return []

    // Unread counts: one aggregation across all conversations for this user
    const convIds = convs.map(c => c.id)
    const unreadRows = await db.collection(MSGS).aggregate([
        { $match: { conversationId: { $in: convIds }, senderId: { $ne: uid }, readAt: null } },
        { $group: { _id: '$conversationId', unread: { $sum: 1 } } },
    ]).toArray()

    const unreadMap = Object.fromEntries(unreadRows.map(r => [r._id, r.unread]))

    // Enrich with the other participant's display name. Bots aren't real user docs —
    // the client renders their brand/avatar from agent metadata — so skip them here.
    const otherIds = [...new Set(
        convs.flatMap(c => c.participants.filter(p => p !== uid && !isBot(p)))
    )]
    const userDocs = otherIds.length
        ? await db.collection('users')
            .find({ id: { $in: otherIds } }, { projection: { id: 1, username: 1, fullname: 1 } })
            .toArray()
        : []
    const userMap = Object.fromEntries(userDocs.map(u => [u.id, u]))

    return convs.map(c => {
        const otherId   = c.participants.find(p => p !== uid) ?? ''
        const otherUser = userMap[otherId]
        return {
            ...stripId(c),
            unread:        unreadMap[c.id] ?? 0,
            otherName:     otherUser?.fullname  ?? null,
            otherUsername: otherUser?.username  ?? null,
        }
    })
}

export async function getMessages(conversationId, userId, before, limit = 50) {
    const db   = await getDb()
    const conv = await db.collection(CONVS).findOne({ id: conversationId })
    if (!conv || !conv.participants.includes(String(userId))) return null

    const query = { conversationId }
    if (before) query.createdAt = { $lt: Number(before) }

    const msgs = await db.collection(MSGS)
        .find(query)
        .sort({ createdAt: -1 })
        .limit(Math.min(limit, 100))
        .toArray()

    return msgs.map(stripId).reverse()
}

export async function markRead(conversationId, userId) {
    const db  = await getDb()
    const uid = String(userId)

    const conv = await db.collection(CONVS).findOne({ id: conversationId })
    if (!conv || !conv.participants.includes(uid)) return { ok: false }

    await db.collection(MSGS).updateMany(
        { conversationId, senderId: { $ne: uid }, readAt: null },
        { $set: { readAt: Date.now() } }
    )
    return { ok: true }
}

// Mark a single message as dismissed (used by the invalidation-alert bubble so the
// user's choice persists — the message stays but renders acknowledged). Message-level
// only; it never touches the idea's invalidation latch, so a re-armed idea still emits
// a fresh new alert message.
export async function dismissMessage(conversationId, messageId, userId, outcome = null) {
    const db  = await getDb()
    const uid = String(userId)

    const conv = await db.collection(CONVS).findOne({ id: conversationId })
    if (!conv || !conv.participants.includes(uid)) return { ok: false }

    // `dismissed` collapses the card to an acknowledged state; `dismissOutcome` records WHICH
    // action the user took (dismissed | editing | closing…) so the collapsed card reads "handled"
    // accurately rather than always "Dismissed".
    await db.collection(MSGS).updateOne(
        { id: messageId, conversationId },
        { $set: { dismissed: true, ...(outcome ? { dismissOutcome: String(outcome) } : {}) } }
    )
    return { ok: true }
}

/**
 * Flip a portfolio_review notification card to a resolved state after the user finishes a
 * review (dismissed with no changes, or accepted an update). Finds the latest portfolio_review
 * message for this portfolio in the user's Atlas-bot ('portfolio') conversation and stamps its
 * payload with the outcome + next review date, so the card renders "Dismissed/Updated · next
 * review <date>" and stops routing into an active review. No-op (safe) when there's no such
 * conversation/card. Patched payload surfaces on the client's next social-chat load.
 * @param {string} userId
 * @param {string} portfolioId
 * @param {{ nextReviewAt?: number|null, outcome?: 'dismissed'|'updated' }} [opts]
 */
export async function resolvePortfolioReviewCard(userId, portfolioId, { nextReviewAt = null, outcome = 'dismissed' } = {}) {
    try {
        const db = await getDb()
        const participants = [String(userId), 'portfolio'].sort()
        const conv = await db.collection(CONVS).findOne({ participants })
        if (!conv) return { ok: false, reason: 'no_conversation' }

        const msg = await db.collection(MSGS)
            .find({ conversationId: conv.id, type: 'portfolio_review', 'payload.portfolioId': portfolioId })
            .sort({ createdAt: -1 })
            .limit(1)
            .next()
        if (!msg) return { ok: false, reason: 'no_card' }

        await db.collection(MSGS).updateOne(
            { id: msg.id },
            { $set: { 'payload.resolved': true, 'payload.outcome': outcome, 'payload.nextReviewAt': nextReviewAt } }
        )
        return { ok: true, messageId: msg.id }
    } catch (err) {
        logger.error(LOG, 'resolvePortfolioReviewCard failed', err)
        return { ok: false, reason: 'error' }
    }
}

export async function searchUsers(query, currentUserId) {
    if (!query || query.trim().length < 2) return []
    const db     = await getDb()
    // Escape regex metacharacters before building the matcher: the query is raw
    // user input, so an unescaped pattern like "(a+)+$" is a catastrophic-
    // backtracking (ReDoS) vector, and stray metachars break intended matching.
    const safe   = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex  = new RegExp(safe, 'i')
    const users  = await db.collection('users')
        .find({
            id:       { $ne: String(currentUserId) },
            username: { $nin: BOT_IDS },
            $or: [{ username: regex }, { fullname: regex }],
        })
        .project({ id: 1, username: 1, fullname: 1 })
        .limit(20)
        .toArray()

    return users.map(stripId)
}
