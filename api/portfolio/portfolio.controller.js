import { portfolioAgentService } from '../../services/portfolio.agent.service.js'
import { portfolioChatService }  from './portfolioChat.service.js'
import { logger }                from '../../services/logger.service.js'

const LOG = '[portfolio:controller]'

export async function streamPortfolio(req, res) {
    const { messages, ideaAccounts, portfolioId, portfolioIdeas } = req.body ?? {}

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages must be a non-empty array' })
    }

    const validatedAccounts = Array.isArray(ideaAccounts)
        ? ideaAccounts.filter(a => a && typeof a === 'object' && a.id)
        : []

    res.setHeader('Content-Type',  'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection',    'keep-alive')
    res.flushHeaders()

    function sendEvent(event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
        const result = await portfolioAgentService.chatStream({
            messages,
            ideaAccounts: validatedAccounts,
            portfolioId:   portfolioId   ?? null,
            portfolioIdeas: Array.isArray(portfolioIdeas) ? portfolioIdeas : [],
            onToken:  (text)   => sendEvent('token',  { text }),
            onTicker: (symbol) => sendEvent('ticker', { symbol }),
        })

        sendEvent('done', { reply: result.reply, plan: result.plan ?? null, update: result.update ?? null })
        res.end()
    } catch (err) {
        logger.error(LOG, 'Portfolio stream failed', err)
        sendEvent('error', { message: 'Streaming failed' })
        res.end()
    }
}

export async function savePortfolioChatState(req, res) {
    try {
        const { portfolioId, messages } = req.body ?? {}
        if (!portfolioId || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Missing portfolioId or messages' })
        }
        const result = await portfolioChatService.saveChatState(portfolioId, messages, req.user._id)
        if (!result.ok) return res.status(500).json({ error: 'Failed to save' })
        res.json({ ok: true })
    } catch (err) {
        logger.error(LOG, 'savePortfolioChatState failed', err)
        res.status(500).json({ error: 'Failed to save chat state' })
    }
}

export async function getPortfolioChatState(req, res) {
    try {
        const { portfolioId } = req.params
        const chatState = await portfolioChatService.getChatState(portfolioId, req.user._id)
        res.json({ chatState: chatState ?? null })
    } catch (err) {
        logger.error(LOG, 'getPortfolioChatState failed', err)
        res.status(500).json({ error: 'Failed to get chat state' })
    }
}

export async function deletePortfolioChatState(req, res) {
    try {
        const { portfolioId } = req.params
        if (!portfolioId) return res.status(400).json({ error: 'Missing portfolioId' })
        await portfolioChatService.deleteChatState(portfolioId, req.user._id)
        res.json({ ok: true })
    } catch (err) {
        logger.error(LOG, 'deletePortfolioChatState failed', err)
        res.status(500).json({ error: 'Failed to delete chat state' })
    }
}
