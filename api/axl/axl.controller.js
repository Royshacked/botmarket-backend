import { axlAgentService } from '../../services/axl.agent.service.js'
import { resolveModel }    from '../../services/modelRouter.service.js'
import { streamAgentResponse } from '../_shared/sse.util.js'
import { parseChatMessages } from '../_shared/parse.util.js'

const VALID_PIPELINES = new Set(['trade', 'portfolio', 'scan', 'research'])
const LOG = '[axl:controller]'

// SSE reception routing — streams a short Axl comment then emits the resolved pipeline
// key in the `done` payload so the frontend can navigate to the right desk.
export async function routeAxl(req, res) {
    const { message } = req.body ?? {}
    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message is required' })
    }

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const result = await axlAgentService.routeIntent({
                message: message.trim(),
                userId:  req.user._id,
                signal,
                onToken:     (text)  => sendEvent('token',     { text }),
                onReasoning: (text)  => sendEvent('reasoning', { text }),
                onOpenChart: (chart) => sendEvent('chart_open', chart),
            })
            const route = VALID_PIPELINES.has(result.route) ? result.route : null
            return { reply: result.reply, route, chart: result.chart ?? null }
        },
    })
}

// SSE chat with Axl — the 4th-agent chat surface (concierge / app-guide, read-only).
// Same shape as the scanner stream, minus artifacts: Axl emits no <trade_idea>/scan,
// only text (+ status/reasoning). Model routing follows the user's shared AI-mode
// (agent 'axl' is phaseless → auto/classifier fall back to the default route).
export async function streamAxl(req, res) {
    const { messages, model, reasoningEffort, routingMode } = req.body ?? {}

    const validated = parseChatMessages(messages)
    if (validated.error) return res.status(400).json({ error: validated.error })

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const lastMessage = messages.at(-1)?.content ?? ''
            const routing = await resolveModel({ routingMode, agent: 'axl', phase: null, model, reasoningEffort, lastMessage })

            const result = await axlAgentService.chatStream({
                messages,
                model:           routing.model,
                reasoningEffort: routing.reasoningEffort,
                userId:  req.user._id,
                signal:  signal,
                onToken:     (text)  => sendEvent('token',     { text }),
                onToolStart: (tool)  => sendEvent('status',    { tool }),
                onReasoning: (text)  => sendEvent('reasoning', { text }),
                onOpenChart: (chart) => sendEvent('chart_open', chart),
            })

            return { reply: result.reply, chart: result.chart ?? null }
        },
    })
}
