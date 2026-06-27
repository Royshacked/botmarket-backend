import { getDb }  from '../../providers/mongodb.provider.js'
import { logger } from '../../services/logger.service.js'

const LOG   = '[chat]'
const CONVS = 'chat_conversations'
const MSGS  = 'chat_messages'

export const BOT_USER_ID = 'ar2trade_bot'
const BOT_WELCOME = "Hi! I'm your ar2trade assistant. I'll notify you here about portfolio reviews, position alerts, and anything else that needs your attention."

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
    if (existing) return { conv: _stripId(existing), created: false }

    const conv = {
        id:            `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        participants,
        createdAt:     Date.now(),
        lastMessageAt: Date.now(),
        lastMessage:   '',
    }
    await db.collection(CONVS).insertOne(conv)
    return { conv: _stripId(conv), created: true }
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
    return _stripId(msg)
}

/**
 * The single function all platform features call to notify a user from the bot.
 * Writes to DB then pushes a WS event to the user if they are connected.
 */
export async function sendBotMessage(userId, content, type = 'text', payload = null) {
    try {
        const { conv } = await getOrCreateConversation(userId, BOT_USER_ID)
        const msg = await sendMessage(conv.id, BOT_USER_ID, content, type, payload)
        await _tryEmit(String(userId), 'new_message', msg)
        return msg
    } catch (err) {
        logger.error(LOG, 'sendBotMessage failed', err)
        return null
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

    // Enrich with the other participant's display name
    const otherIds = [...new Set(
        convs.flatMap(c => c.participants.filter(p => p !== uid && p !== BOT_USER_ID))
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
            ..._stripId(c),
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

    return msgs.map(_stripId).reverse()
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

export async function searchUsers(query, currentUserId) {
    if (!query || query.trim().length < 2) return []
    const db     = await getDb()
    const regex  = new RegExp(query.trim(), 'i')
    const users  = await db.collection('users')
        .find({
            id:       { $ne: String(currentUserId) },
            username: { $ne: BOT_USER_ID },
            $or: [{ username: regex }, { fullname: regex }],
        })
        .project({ id: 1, username: 1, fullname: 1 })
        .limit(20)
        .toArray()

    return users.map(_stripId)
}

function _stripId(doc) {
    if (!doc) return doc
    const { _id, ...rest } = doc
    return rest
}
