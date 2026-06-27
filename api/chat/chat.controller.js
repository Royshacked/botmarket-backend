import { getDb }  from '../../providers/mongodb.provider.js'
import {
    getConversations,
    getMessages,
    sendMessage,
    markRead,
    searchUsers,
    getOrCreateConversation,
} from './chat.service.js'
import { emit }   from './chatWs.js'

export async function listConversations(req, res, next) {
    try {
        const convs = await getConversations(req.user._id)
        res.json({ conversations: convs })
    } catch (err) {
        next(err)
    }
}

export async function listMessages(req, res, next) {
    try {
        const { id } = req.params
        const { before, limit } = req.query
        const msgs = await getMessages(id, req.user._id, before, Number(limit) || 50)
        if (msgs === null) return res.status(403).json({ error: 'Forbidden' })
        res.json({ messages: msgs })
    } catch (err) {
        next(err)
    }
}

export async function postMessage(req, res, next) {
    try {
        const { id: conversationId } = req.params
        const { content } = req.body ?? {}
        if (!content?.trim()) return res.status(400).json({ error: 'content required' })

        // Verify sender is a participant before writing
        const msgs = await getMessages(conversationId, req.user._id, null, 0)
        if (msgs === null) return res.status(403).json({ error: 'Forbidden' })

        const msg = await sendMessage(conversationId, req.user._id, content.trim())

        // Push to the other participant if they are connected
        const db   = await getDb()
        const conv = await db.collection('chat_conversations').findOne({ id: conversationId })
        if (conv) {
            const recipientId = conv.participants.find(p => p !== String(req.user._id))
            if (recipientId) emit(recipientId, 'new_message', msg)
        }

        res.json({ message: msg })
    } catch (err) {
        next(err)
    }
}

export async function markConversationRead(req, res, next) {
    try {
        const { id } = req.params
        await markRead(id, req.user._id)
        res.json({ ok: true })
    } catch (err) {
        next(err)
    }
}

export async function searchUsersHandler(req, res, next) {
    try {
        const { q } = req.query
        const users = await searchUsers(q, req.user._id)
        res.json({ users })
    } catch (err) {
        next(err)
    }
}

export async function startConversation(req, res, next) {
    try {
        const { userId } = req.body ?? {}
        if (!userId) return res.status(400).json({ error: 'userId required' })
        const { conv } = await getOrCreateConversation(req.user._id, userId)
        res.json({ conversation: conv })
    } catch (err) {
        next(err)
    }
}
