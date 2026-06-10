import { portfolioAgentService } from '../../services/portfolio.agent.service.js'
import { logger }                from '../../services/logger.service.js'

const LOG = '[portfolio:controller]'

export async function streamPortfolio(req, res) {
    const { messages, ideaAccounts } = req.body ?? {}

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ err: 'messages must be a non-empty array' })
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
            onToken:  (text)   => sendEvent('token',  { text }),
            onTicker: (symbol) => sendEvent('ticker', { symbol }),
        })

        sendEvent('done', { reply: result.reply })
        res.end()
    } catch (err) {
        console.error(LOG, err)
        logger.error('Portfolio stream failed', err)
        sendEvent('error', { message: 'Streaming failed' })
        res.end()
    }
}
