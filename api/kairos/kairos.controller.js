import { logger }              from '../../services/logger.service.js'
import { kairosAgentService, emptyKairosState, _finalizeCall } from '../../services/kairos.agent.service.js'
import { kairosService }       from './kairos.service.js'
import { kairosHandoffService } from '../../services/kairos.handoff.service.js'
import { resolveModel }        from '../../services/modelRouter.service.js'
import { startSseStream }      from '../_shared/sse.util.js'

const LOG = '[kairos:controller]'
const MAX_RECENT_CHAT_TURNS = 4

// Build conversation. Streams tokens/chart/status; the agent emits a DRAFT call in `done`
// (unsaved). Persisting happens only on Generate → generateKairosCall.
export async function streamKairos(req, res) {
    const parsed = parseStreamBody(req.body)
    if (parsed.error) return res.status(400).json({ error: parsed.error })

    const { sendEvent, signal, finish } = startSseStream(req, res)

    try {
        const { routingMode, currentPhase, model, reasoningEffort } = req.body ?? {}
        const lastMessage = parsed.messages?.at(-1)?.content ?? parsed.userPrompt ?? ''
        const routing = await resolveModel({ routingMode, agent: 'kairos', phase: currentPhase, model, reasoningEffort, lastMessage })

        const result = await kairosAgentService.chatStream({
            messages:      parsed.messages,
            userPrompt:    parsed.userPrompt,
            chatState:     parsed.chatState ?? emptyKairosState(),
            accounts:      parsed.accounts,
            model:         routing.model,
            reasoningEffort: routing.reasoningEffort,
            userId:        req.user._id,
            signal,
            onToken:     (text)   => sendEvent('token',     { text }),
            onChart:     (chart)  => sendEvent('chart',     chart),
            onToolStart: (tool)   => sendEvent('status',    { tool }),
            onReasoning: (text)   => sendEvent('reasoning', { text }),
            onPhase:     (phase)  => sendEvent('phase',     { phase }),
        })

        finish()
        if (!signal.aborted) {
            // `call` here is a DRAFT for preview — the client shows it and lets the user Generate.
            sendEvent('done', { reply: result.reply, phase: result.phase ?? null, ...(result.call ? { call: result.call } : {}) })
            res.end()
        }
    } catch (err) {
        finish()
        if (signal.aborted) return
        logger.error(LOG, 'Failed to stream kairos', err)
        sendEvent('error', { message: 'Streaming failed' })
        res.end()
    }
}

// Generate: persist a drafted call. Binds the marked accounts (bank icon) + resolves the venue,
// runs the construction gate, saves. Returns the saved call or a gate reason.
export async function generateKairosCall(req, res) {
    try {
        const { call, accounts, mainAccountId } = req.body ?? {}
        if (!call || typeof call !== 'object' || Array.isArray(call)) {
            return res.status(400).send({ error: 'call must be an object' })
        }
        const acctList = Array.isArray(accounts) ? accounts : []

        const result = await _finalizeCall(call, { userId: req.user._id, accounts: acctList, mainAccountId })
        if (!result.ok) return res.status(400).send({ error: result.reason ?? 'generate_failed' })

        res.send(result.call)
    } catch (err) {
        logger.error(LOG, 'Failed to generate kairos call', err)
        res.status(500).send({ error: 'Failed to generate call' })
    }
}

// Act on a readiness card. action ∈ confirm | edit | dismiss.
export async function actOnKairosCall(req, res) {
    const { id }     = req.params
    const { action } = req.body ?? {}
    const userId  = req.user._id
    const isAdmin = req.user.isAdmin === true

    let result
    if (action === 'confirm')      result = await kairosHandoffService.confirmCall(id, userId, isAdmin)
    else if (action === 'edit')    result = await kairosHandoffService.editCall(id, userId, isAdmin)
    else if (action === 'dismiss') result = await kairosHandoffService.dismissCall(id, userId, isAdmin)
    else return res.status(400).send({ error: 'action must be confirm | edit | dismiss' })

    if (!result.ok) {
        const code = result.reason === 'not_found' ? 404 : result.reason === 'forbidden' ? 403 : 400
        return res.status(code).send({ error: result.reason ?? 'action_failed' })
    }
    res.send(result)
}

export async function listKairos(req, res) {
    try {
        const items = await kairosService.listKairosCalls(req.user._id, req.user.isAdmin === true)
        res.send(items)
    } catch (err) {
        logger.error(LOG, 'Failed to list kairos calls', err)
        res.status(500).send({ error: 'Failed to list calls' })
    }
}

export async function deleteKairos(req, res) {
    try {
        const result = await kairosService.deleteKairosCall(req.params.id, req.user._id, req.user.isAdmin === true)
        if (!result.ok) {
            const code = result.reason === 'not_found' ? 404 : result.reason === 'forbidden' ? 403 : 400
            return res.status(code).send({ error: result.reason ?? 'delete_failed' })
        }
        res.send({ ok: true })
    } catch (err) {
        logger.error(LOG, 'Failed to delete kairos call', err)
        res.status(500).send({ error: 'Failed to delete call' })
    }
}

function parseStreamBody(body) {
    const { messages, userPrompt, chatState, accounts } = body ?? {}
    const trimmedPrompt = typeof userPrompt === 'string' ? userPrompt.trim() : ''

    let state = null
    if (chatState !== undefined && chatState !== null) {
        if (typeof chatState !== 'object' || Array.isArray(chatState)) return { error: 'chatState must be an object' }
        state = chatState
    }

    const acctList = Array.isArray(accounts) ? accounts.filter(a => a && typeof a === 'object') : []

    if (messages !== undefined && messages !== null) {
        if (!Array.isArray(messages)) return { error: 'messages must be an array' }
        if (messages.length === 0) {
            if (trimmedPrompt) return { userPrompt: trimmedPrompt, chatState: state, accounts: acctList }
            return { error: 'messages must be a non-empty array' }
        }
        const trimmed = messages
            .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
            .map(({ role, content }) => ({ role, content: content.trim() }))
            .slice(-MAX_RECENT_CHAT_TURNS * 2)
        return { userPrompt: trimmedPrompt || undefined, messages: trimmed, chatState: state, accounts: acctList }
    }

    if (trimmedPrompt) return { userPrompt: trimmedPrompt, chatState: state, accounts: acctList }
    return { error: 'Request must include messages or userPrompt' }
}
