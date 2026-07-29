import { axlAgentService } from '../../services/axl.agent.service.js'
import { resolveModel }    from '../../services/modelRouter.service.js'
import { streamAgentResponse } from '../_shared/sse.util.js'
import { parseChatMessages } from '../_shared/parse.util.js'

// The desks a reply may hand the user to. Validated here rather than trusted from the model: an
// unknown key would leave the client trying to navigate to a tab that doesn't exist, so it becomes
// null and the user simply stays with Axl.
const VALID_PIPELINES = new Set(['trade', 'portfolio', 'scan', 'research'])
const LOG = '[axl:controller]'

// SSE chat with Axl — the one Axl surface. It answers, remembers the thread, docks charts, and
// routes to a desk when the user wants one (`route` in the `done` payload). There is deliberately no
// second endpoint: a separate one-shot `/route` doorman used to answer the landing box with no
// history and no app knowledge, which meant confident wrong answers and follow-ups that couldn't
// resolve. Model routing follows the user's shared AI-mode (agent 'axl' is phaseless → auto/
// classifier fall back to the default route).
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
                onChart:     (chart) => sendEvent('chart',     chart),
            })

            return {
                reply: result.reply,
                route: VALID_PIPELINES.has(result.route) ? result.route : null,
                chart: result.chart ?? null,
            }
        },
    })
}
