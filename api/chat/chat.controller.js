import {
    getConversations,
    getMessages,
    postUserMessage,
    markRead,
    dismissMessage,
    searchUsers,
    getOrCreateConversation,
} from './chat.service.js'

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
        const { content, routingMode, model, reasoningEffort } = req.body ?? {}
        if (!content?.trim()) return res.status(400).json({ error: 'content required' })

        const result = await postUserMessage(conversationId, req.user._id, content.trim(), { routingMode, model, reasoningEffort })
        if (!result.ok) return res.status(403).json({ error: 'Forbidden' })
        res.json({ message: result.message })
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

export async function dismissMessageHandler(req, res, next) {
    try {
        const { id, msgId } = req.params
        const result = await dismissMessage(id, msgId, req.user._id, req.body?.outcome ?? null)
        if (!result.ok) return res.status(403).json({ error: 'Forbidden' })
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
