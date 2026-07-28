import { logger }           from '../../services/logger.service.js'
import { ideaAgentService, emptyAnalysisState } from '../../services/idea.agent.service.js'
import { brokerService }     from '../broker/broker.service.js'
import { resolveModel }      from '../../services/modelRouter.service.js'
import { streamAgentResponse } from '../_shared/sse.util.js'
import { parseIdeaAccounts, parseChatMessages } from '../_shared/parse.util.js'

const LOG = '[idea:controller]'

const MAX_RECENT_CHAT_TURNS = 3

export async function streamIdea(req, res) {
    const parsed = parseIdeaBody(req.body)
    if (parsed.error) {
        return res.status(400).json({ error: parsed.error })
    }

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const brokerContext = await brokerService.loadContext(req.user._id)

            const { routingMode, currentPhase, model, reasoningEffort } = req.body ?? {}
            const lastMessage = parsed.messages?.at(-1)?.content ?? parsed.userPrompt ?? ''
            const routing = await resolveModel({ routingMode, agent: 'idea', phase: currentPhase, model, reasoningEffort, lastMessage })

            const result = await ideaAgentService.chatStream({
                messages:      parsed.messages,
                userPrompt:    parsed.userPrompt,
                analysisState: parsed.analysisState ?? emptyAnalysisState(),
                brokerContext,
                ideaAccounts:  parsed.ideaAccounts ?? [],
                mainAccountId: parsed.mainAccountId ?? null,
                clientTime:    parsed.clientTime ?? null,
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

            return {
                reply:         result.reply,
                analysisState: result.analysisState,
                phase:         result.phase ?? null,
                ...(result.tradeIdea ? { tradeIdea: result.tradeIdea } : {}),
            }
        },
    })
}

export async function getIdea(req, res) {
    try {
        const parsed = parseIdeaBody(req.body)
        if (parsed.error) {
            return res.status(400).send({ error: parsed.error })
        }

        const brokerContext = await brokerService.loadContext(req.user._id)

        const result = await ideaAgentService.chat({
            messages:      parsed.messages,
            userPrompt:    parsed.userPrompt,
            analysisState: parsed.analysisState ?? emptyAnalysisState(),
            brokerContext,
            clientTime:    parsed.clientTime ?? null,
        })

        res.send(result)
    } catch (err) {
        logger.error(LOG, 'Failed to run idea', err)
        res.status(500).send({ error: 'Failed to run idea' })
    }
}

function parseIdeaBody(body) {
    const { messages, userPrompt, analysisState, ideaAccounts } = body ?? {}
    const trimmedPrompt = typeof userPrompt === 'string' ? userPrompt.trim() : ''
    const clientTime = parseClientTime(body)
    // Starred main account (bank icon) → lets Idea name which account the trade binds to,
    // matching what batch-create resolves. Normalized to string; null when unmarked.
    const mainAccountId = body?.mainAccountId != null ? String(body.mainAccountId) : null

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
                return { userPrompt: trimmedPrompt, analysisState: priorState, ideaAccounts: parseIdeaAccounts(ideaAccounts), mainAccountId, clientTime }
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
            mainAccountId,
            clientTime,
        }
    }

    if (trimmedPrompt) {
        return { userPrompt: trimmedPrompt, analysisState: priorState, ideaAccounts: parseIdeaAccounts(ideaAccounts), mainAccountId, clientTime }
    }

    return { error: 'Request must include messages or userPrompt' }
}

// Browser-supplied local time context ({ clientNow: ms, clientTz: IANA string }) used to
// resolve clock/date times against the user's timezone. Both fields optional and
// individually validated — a bad value is dropped, never fatal. Returns null when neither
// usable field is present.
function parseClientTime(body) {
    const now = Number(body?.clientNow)
    const tz  = typeof body?.clientTz === 'string' ? body.clientTz.trim() : ''
    const clientTime = {}
    if (Number.isFinite(now) && now > 0) clientTime.clientNow = now
    if (tz) clientTime.clientTz = tz
    return (clientTime.clientNow || clientTime.clientTz) ? clientTime : null
}
