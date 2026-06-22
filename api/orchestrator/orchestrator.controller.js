import { logger }           from '../../services/logger.service.js'
import { tradeAgentService, emptyAnalysisState } from '../../services/trade.agent.service.js'
import { brokerService }     from '../broker/broker.service.js'

const LOG = '[orchestrator:controller]'

const ALLOWED_MESSAGE_ROLES = new Set(['user', 'assistant'])
const MAX_RECENT_CHAT_TURNS = 3

export async function streamOrchestration(req, res) {
    const parsed = parseOrchestratorBody(req.body)
    if (parsed.error) {
        return res.status(400).json({ error: parsed.error })
    }

    // SSE headers
    res.setHeader('Content-Type',  'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection',    'keep-alive')
    res.flushHeaders()

    function sendEvent(event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    // User hit Stop → the browser aborts the fetch and the connection closes.
    // Abort the agent loop so it stops generating instead of finishing silently.
    const ac = new AbortController()
    let finished = false
    req.on('close', () => { if (!finished) ac.abort() })

    try {
        const brokerContext = await _loadBrokerContext(req.user._id)

        const result = await tradeAgentService.chatStream({
            messages:      parsed.messages,
            userPrompt:    parsed.userPrompt,
            analysisState: parsed.analysisState ?? emptyAnalysisState(),
            brokerContext,
            ideaAccounts:  parsed.ideaAccounts ?? [],
            model:         req.body?.model,
            signal:        ac.signal,
            onToken:       (text)     => sendEvent('token',    { text }),
            onAsset:       (symbol)   => sendEvent('asset',    { symbol }),
            onInterval:    (interval) => sendEvent('interval', { interval }),
            onChart:       (chart)    => sendEvent('chart',    chart),   // { symbol, timeframe, imageBase64 }
        })

        finished = true
        if (!ac.signal.aborted) {
            sendEvent('done', {
                reply:         result.reply,
                analysisState: result.analysisState,
                ...(result.tradeIdea ? { tradeIdea: result.tradeIdea } : {}),
            })
            res.end()
        }
    } catch (err) {
        finished = true
        if (ac.signal.aborted) return   // client gone — nothing to send
        logger.error(LOG, 'Failed to stream orchestration', err)
        sendEvent('error', { message: 'Streaming failed' })
        res.end()
    }
}

export async function getOrchestration(req, res) {
    try {
        const parsed = parseOrchestratorBody(req.body)
        if (parsed.error) {
            return res.status(400).send({ error: parsed.error })
        }

        const brokerContext = await _loadBrokerContext(req.user._id)

        const result = await tradeAgentService.chat({
            messages:      parsed.messages,
            userPrompt:    parsed.userPrompt,
            analysisState: parsed.analysisState ?? emptyAnalysisState(),
            brokerContext,
        })

        res.send(result)
    } catch (err) {
        logger.error(LOG, 'Failed to run orchestration', err)
        res.status(500).send({ error: 'Failed to run orchestration' })
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

function parseOrchestratorBody(body) {
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
        if (messages.length === 0) {
            if (trimmedPrompt) {
                return { userPrompt: trimmedPrompt, analysisState: priorState, ideaAccounts: _parseIdeaAccounts(ideaAccounts) }
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
            userPrompt:    trimmedPrompt || undefined,
            messages:      trimmed,
            analysisState: priorState,
            ideaAccounts:  _parseIdeaAccounts(ideaAccounts),
        }
    }

    if (trimmedPrompt) {
        return { userPrompt: trimmedPrompt, analysisState: priorState, ideaAccounts: _parseIdeaAccounts(ideaAccounts) }
    }

    return { error: 'Request must include messages or userPrompt' }
}

function _parseIdeaAccounts(raw) {
    if (!Array.isArray(raw)) return []
    return raw.filter(a => a && typeof a === 'object' && a.id)
}
