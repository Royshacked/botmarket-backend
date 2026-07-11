import { logger }           from '../../services/logger.service.js'
import { ideaAgentService, emptyAnalysisState } from '../../services/idea.agent.service.js'
import { brokerService }     from '../broker/broker.service.js'
import { resolveModel }      from '../../services/modelRouter.service.js'
import { startSseStream }    from '../_shared/sse.util.js'
import { parseIdeaAccounts, parseChatMessages } from '../_shared/parse.util.js'

const LOG = '[idea:controller]'

const MAX_RECENT_CHAT_TURNS = 3

export async function streamIdea(req, res) {
    const parsed = parseIdeaBody(req.body)
    if (parsed.error) {
        return res.status(400).json({ error: parsed.error })
    }

    const { sendEvent, signal, finish } = startSseStream(req, res)

    try {
        const brokerContext = await _loadBrokerContext(req.user._id)

        const { routingMode, currentPhase, model, reasoningEffort } = req.body ?? {}
        const lastMessage = parsed.messages?.at(-1)?.content ?? parsed.userPrompt ?? ''
        const routing = await resolveModel({ routingMode, agent: 'idea', phase: currentPhase, model, reasoningEffort, lastMessage })

        const result = await ideaAgentService.chatStream({
            messages:      parsed.messages,
            userPrompt:    parsed.userPrompt,
            analysisState: parsed.analysisState ?? emptyAnalysisState(),
            brokerContext,
            ideaAccounts:  parsed.ideaAccounts ?? [],
            model:         routing.model,
            reasoningEffort: routing.reasoningEffort,
            userId:        req.user._id,
            signal:        signal,
            onToken:       (text)     => sendEvent('token',    { text }),
            onAsset:       (symbol)   => sendEvent('asset',    { symbol }),
            onInterval:    (interval) => sendEvent('interval', { interval }),
            onChart:       (chart)    => sendEvent('chart',    chart),
            onPhase:       (phase)    => sendEvent('phase',     { phase }),
            onToolStart:   (tool)     => sendEvent('status',    { tool }),
            onReasoning:   (text)     => sendEvent('reasoning', { text }),
        })

        finish()
        if (!signal.aborted) {
            sendEvent('done', {
                reply:         result.reply,
                analysisState: result.analysisState,
                phase:         result.phase ?? null,
                ...(result.tradeIdea ? { tradeIdea: result.tradeIdea } : {}),
            })
            res.end()
        }
    } catch (err) {
        finish()
        if (signal.aborted) return   // client gone — nothing to send
        logger.error(LOG, 'Failed to stream idea', err)
        sendEvent('error', { message: 'Streaming failed' })
        res.end()
    }
}

export async function getIdea(req, res) {
    try {
        const parsed = parseIdeaBody(req.body)
        if (parsed.error) {
            return res.status(400).send({ error: parsed.error })
        }

        const brokerContext = await _loadBrokerContext(req.user._id)

        const result = await ideaAgentService.chat({
            messages:      parsed.messages,
            userPrompt:    parsed.userPrompt,
            analysisState: parsed.analysisState ?? emptyAnalysisState(),
            brokerContext,
        })

        res.send(result)
    } catch (err) {
        logger.error(LOG, 'Failed to run idea', err)
        res.status(500).send({ error: 'Failed to run idea' })
    }
}

async function _loadBrokerContext(userId) {
    try {
        const connections = await brokerService.listConnections(userId)
        const entries = await Promise.all(
            Object.entries(connections)
                .filter(([, connected]) => connected)
                .map(async ([type]) => {
                    try {
                        const account = await brokerService.getAccount(type, userId)
                        let positions = []
                        try {
                            positions = await brokerService.getPositions(type, userId)
                        } catch { /* positions not available via REST — leave empty */ }
                        return [type, { account, positions }]
                    } catch { return null }
                })
        )
        return Object.fromEntries(entries.filter(Boolean))
    } catch { return {} }
}

function parseIdeaBody(body) {
    const { messages, userPrompt, analysisState, ideaAccounts } = body ?? {}
    const trimmedPrompt = typeof userPrompt === 'string' ? userPrompt.trim() : ''

    let priorState = null
    if (analysisState !== undefined && analysisState !== null) {
        if (typeof analysisState !== 'object' || Array.isArray(analysisState)) {
            return { error: 'analysisState must be an object' }
        }
        priorState = analysisState
    }

    if (messages !== undefined && messages !== null) {
        if (!Array.isArray(messages)) {
            return { error: 'messages must be an array' }
        }
        // Empty messages with a userPrompt fallback is allowed here (unlike the
        // shared validator, which treats empty as an error).
        if (messages.length === 0) {
            if (trimmedPrompt) {
                return { userPrompt: trimmedPrompt, analysisState: priorState, ideaAccounts: parseIdeaAccounts(ideaAccounts) }
            }
            return { error: 'messages must be a non-empty array' }
        }

        const validated = parseChatMessages(messages)
        if (validated.error) return { error: validated.error }

        const trimmed = validated.messages.slice(-MAX_RECENT_CHAT_TURNS * 2)
        return {
            userPrompt:    trimmedPrompt || undefined,
            messages:      trimmed,
            analysisState: priorState,
            ideaAccounts:  parseIdeaAccounts(ideaAccounts),
        }
    }

    if (trimmedPrompt) {
        return { userPrompt: trimmedPrompt, analysisState: priorState, ideaAccounts: parseIdeaAccounts(ideaAccounts) }
    }

    return { error: 'Request must include messages or userPrompt' }
}
