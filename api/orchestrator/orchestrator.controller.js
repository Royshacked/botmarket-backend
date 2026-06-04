import { logger } from '../../services/logger.service.js'
import { tradeAgentService } from '../../services/trade.agent.service.js'

const LOG = '[orchestrator:controller]'

const ALLOWED_MESSAGE_ROLES = new Set(['user', 'assistant'])
const MAX_RECENT_CHAT_TURNS = 3

export async function streamOrchestration(req, res) {
    const parsed = parseOrchestratorBody(req.body)
    if (parsed.error) {
        return res.status(400).json({ err: parsed.error })
    }

    // SSE headers
    res.setHeader('Content-Type',  'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection',    'keep-alive')
    res.flushHeaders()

    function sendEvent(event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
        const result = await tradeAgentService.chatStream({
            messages:      parsed.messages,
            userPrompt:    parsed.userPrompt,
            analysisState: parsed.analysisState ?? _emptyState(),
            onToken:       (text)   => sendEvent('token',  { text }),
            onAsset:       (symbol) => sendEvent('asset', { symbol }),
        })

        sendEvent('done', {
            reply:         result.reply,
            analysisState: result.analysisState,
            ...(result.tradeIdea ? { tradeIdea: result.tradeIdea } : {}),
        })
        res.end()
    } catch (err) {
        console.log(LOG, 'streamOrchestration error', err)
        logger.error('Failed to stream orchestration', err)
        sendEvent('error', { message: 'Streaming failed' })
        res.end()
    }
}

export async function getOrchestration(req, res) {
    try {
        const parsed = parseOrchestratorBody(req.body)
        if (parsed.error) {
            return res.status(400).send({ err: parsed.error })
        }

        const result = await tradeAgentService.chat({
            messages: parsed.messages,
            userPrompt: parsed.userPrompt,
            analysisState: parsed.analysisState ?? _emptyState(),
        })

        res.send(result)
    } catch (err) {
        console.log(LOG, 'error', err)
        logger.error('Failed to run orchestration', err)
        res.status(500).send({ err: 'Failed to run orchestration' })
    }
}

function _emptyState() {
    return {
        recent_messages: [],
        recent_chat_summary: '',
        structured_state: {
            active_asset: '',
            pending_trade: {
                direction: null,
                type: null,
                entry_timeframe: null,
                stop_timeframe: null,
                tp_timeframe: null,
                entry_conditions: [],
                stop_conditions: [],
                tp_conditions: [],
                notes: null,
            },
        },
    }
}

function parseOrchestratorBody(body) {
    const { messages, userPrompt, analysisState } = body ?? {}
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
        if (messages.length === 0) {
            if (trimmedPrompt) {
                return { userPrompt: trimmedPrompt, analysisState: priorState }
            }
            return { error: 'messages must be a non-empty array' }
        }

        const normalized = []
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i]
            if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
                return { error: `messages[${i}] must be an object with role and content` }
            }
            const { role, content } = msg
            if (!ALLOWED_MESSAGE_ROLES.has(role)) {
                return { error: `messages[${i}].role must be user or assistant` }
            }
            if (typeof content !== 'string' || !content.trim()) {
                return { error: `messages[${i}].content must be a non-empty string` }
            }
            normalized.push({ role, content: content.trim() })
        }

        const trimmed = normalized.slice(-MAX_RECENT_CHAT_TURNS * 2)
        return {
            userPrompt: trimmedPrompt || undefined,
            messages: trimmed,
            analysisState: priorState,
        }
    }

    if (trimmedPrompt) {
        return { userPrompt: trimmedPrompt, analysisState: priorState }
    }

    return { error: 'Request must include messages or userPrompt' }
}
