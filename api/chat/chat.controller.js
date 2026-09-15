import {
    getConversations,
    getMessages,
    postUserMessage,
    markRead,
    resolveMessage,
    searchUsers,
    getOrCreateConversation,
} from './chat.service.js'
import { makeHandle } from '../_shared/handle.util.js'

const LOG     = '[chat:controller]'
const _handle = makeHandle(LOG)

// Eight hand-rolled `try { … } catch (err) { next(err) }` bodies stood here — the last controller in
// the app still writing them out, after §1 moved broker/paper onto this wrapper and §2–§4 took
// tradeIdeas, setups and portfolio.
//
// Unlike those, this one was NOT losing information to the global handler: it already forwarded with
// `next(err)`, so the error shape the client sees is unchanged and this is clear of the §9 decision
// about what an error may say. What it was missing is the LOG line — a failed chat read left nothing
// behind naming the route it failed on.

export const listConversations = _handle('listConversations', async (req, res) => {
    res.json({ conversations: await getConversations(req.user._id, req.user.role) })
})

export const listMessages = _handle('listMessages', async (req, res) => {
    const { id } = req.params
    const { before, limit } = req.query
    const msgs = await getMessages(id, req.user._id, before, Number(limit) || 50, req.user.role)
    // null means "not a participant", which is a refusal rather than an error — see getMessages.
    if (msgs === null) return res.status(403).json({ error: 'Forbidden' })
    res.json({ messages: msgs })
})

export const postMessage = _handle('postMessage', async (req, res) => {
    const { id: conversationId } = req.params
    const { content, model } = req.body ?? {}
    if (!content?.trim()) return res.status(400).json({ error: 'content required' })

    const result = await postUserMessage(conversationId, req.user._id, content.trim(), { model })
    if (!result.ok) return res.status(403).json({ error: 'Forbidden' })
    res.json({ message: result.message })
})

export const markConversationRead = _handle('markConversationRead', async (req, res) => {
    await markRead(req.params.id, req.user._id)
    res.json({ ok: true })
})

// Unified resolution: mark a card 'done' (acted) or 'dismissed'. Body = { status?, outcome? }.
//
// There was a SECOND handler beside this one — `dismissMessageHandler`, on POST …/dismiss — left
// from before the lifecycle was unified. Nothing called it: the client posts to /resolve, and even
// its own `dismissMessage` helper was an alias that did. Removed in §5 along with the route and the
// service alias behind it; `status: 'dismissed'` is how a dismiss is expressed now.
export const resolveMessageHandler = _handle('resolveMessage', async (req, res) => {
    const { id, msgId } = req.params
    const { status = 'dismissed', outcome = null } = req.body ?? {}
    const result = await resolveMessage(id, msgId, req.user._id, { status, outcome })
    if (!result.ok) return res.status(403).json({ error: 'Forbidden' })
    res.json({ ok: true })
})

export const searchUsersHandler = _handle('searchUsers', async (req, res) => {
    res.json({ users: await searchUsers(req.query.q, req.user._id) })
})

export const startConversation = _handle('startConversation', async (req, res) => {
    const { userId } = req.body ?? {}
    if (!userId) return res.status(400).json({ error: 'userId required' })
    const { conv } = await getOrCreateConversation(req.user._id, userId)
    res.json({ conversation: conv })
})
