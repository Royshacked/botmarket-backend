import { portfolioAgentService } from '../../services/portfolio.agent.service.js'
import { portfolioChatService }  from './portfolioChat.service.js'
import { computePortfolioState } from '../../services/portfolioState.service.js'
import { logger }                from '../../services/logger.service.js'

const LOG = '[portfolio:controller]'

export async function streamPortfolio(req, res) {
    const { messages, ideaAccounts, portfolioId, portfolioIdeas, model, reasoningEffort } = req.body ?? {}

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

    // User hit Stop → the browser aborts the fetch and the connection closes.
    // Abort the agent loop so it stops generating instead of finishing silently.
    // NOTE: listen on res, not req — req's 'close' fires as soon as the request
    // body is fully received (Node ≥ ~18), which would abort every stream instantly.
    // res 'close' fires only when the response connection actually closes.
    const ac = new AbortController()
    let finished = false
    res.on('close', () => { if (!finished) ac.abort() })

    try {
        // In review mode, pre-compute live portfolio state and inject into the agent.
        const isReviewMode = req.body?.reviewMode === true
        const portfolioState = (isReviewMode && portfolioId)
            ? await computePortfolioState(portfolioId, req.user._id).catch(() => null)
            : null

        const result = await portfolioAgentService.chatStream({
            messages,
            ideaAccounts: validatedAccounts,
            portfolioId:   portfolioId   ?? null,
            portfolioIdeas: Array.isArray(portfolioIdeas) ? portfolioIdeas : [],
            portfolioState,
            model,
            reasoningEffort,
            signal:   ac.signal,
            onToken:  (text)   => sendEvent('token',  { text }),
            onTicker: (symbol) => sendEvent('ticker', { symbol }),
            onToolStart: (tool) => sendEvent('status', { tool }),
        })

        finished = true
        if (!ac.signal.aborted) {
            sendEvent('done', { reply: result.reply, plan: result.plan ?? null, update: result.update ?? null })
            res.end()
        }
    } catch (err) {
        finished = true
        if (ac.signal.aborted) return   // client gone — nothing to send
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

export async function getPendingReviews(req, res) {
    try {
        const reviews = await portfolioChatService.getPendingReviews(req.user._id)
        res.json({ reviews })
    } catch (err) {
        logger.error(LOG, 'getPendingReviews failed', err)
        res.status(500).json({ error: 'Failed to get pending reviews' })
    }
}

export async function completeReview(req, res) {
    try {
        const { portfolioId } = req.params
        if (!portfolioId) return res.status(400).json({ error: 'Missing portfolioId' })

        const lifecycle = await portfolioChatService.getPortfolioLifecycle(portfolioId, req.user._id)
        const cadence   = req.body?.reviewCadence ?? lifecycle?.reviewCadence ?? 'monthly'
        const cadenceMs = cadence === 'quarterly' ? 90 * 86400000 : 30 * 86400000
        const now       = Date.now()

        await portfolioChatService.setPortfolioLifecycle(portfolioId, req.user._id, {
            reviewCadence: cadence,
            lastReviewAt:  now,
            nextReviewAt:  now + cadenceMs,
        })

        res.json({ ok: true, nextReviewAt: now + cadenceMs })
    } catch (err) {
        logger.error(LOG, 'completeReview failed', err)
        res.status(500).json({ error: 'Failed to complete review' })
    }
}
