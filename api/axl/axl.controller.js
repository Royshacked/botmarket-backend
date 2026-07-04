import { axlAgentService } from '../../services/axl.agent.service.js'
import { logger }          from '../../services/logger.service.js'
import { resolveModel }    from '../../services/modelRouter.service.js'
import { startSseStream }  from '../_shared/sse.util.js'
import { parseChatMessages } from '../_shared/parse.util.js'

const LOG = '[axl:controller]'

// SSE chat with Axl — the 4th-agent chat surface (concierge / app-guide, read-only).
// Same shape as the scanner stream, minus artifacts: Axl emits no <trade_idea>/scan,
// only text (+ status/reasoning). Model routing follows the user's shared AI-mode
// (agent 'axl' is phaseless → auto/classifier fall back to the default route).
export async function streamAxl(req, res) {
    const { messages, model, reasoningEffort, routingMode } = req.body ?? {}

    const validated = parseChatMessages(messages)
    if (validated.error) return res.status(400).json({ error: validated.error })

    const { sendEvent, signal: acSignal, finish } = startSseStream(req, res)
    const ac = { signal: acSignal }

    try {
        const lastMessage = messages.at(-1)?.content ?? ''
        const routing = await resolveModel({ routingMode, agent: 'axl', phase: null, model, reasoningEffort, lastMessage })

        const result = await axlAgentService.chatStream({
            messages,
            model:           routing.model,
            reasoningEffort: routing.reasoningEffort,
            userId:  req.user._id,
            signal:  ac.signal,
            onToken:     (text) => sendEvent('token',     { text }),
            onToolStart: (tool) => sendEvent('status',    { tool }),
            onReasoning: (text) => sendEvent('reasoning', { text }),
        })

        finish()
        if (!ac.signal.aborted) {
            sendEvent('done', { reply: result.reply })
            res.end()
        }
    } catch (err) {
        finish()
        if (ac.signal.aborted) return   // client gone — nothing to send
        logger.error(LOG, 'Axl stream failed', err)
        sendEvent('error', { message: 'Streaming failed' })
        res.end()
    }
}
