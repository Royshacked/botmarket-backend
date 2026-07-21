import { logger }              from '../../services/logger.service.js'
import { kairosAgentService, emptyKairosState, _finalizeCall } from '../../services/kairos.agent.service.js'
import { kairosService }       from './kairos.service.js'
import { brokerService }       from '../broker/broker.service.js'
import { kairosHandoffService } from '../../services/kairos.handoff.service.js'
import { resolveModel }        from '../../services/modelRouter.service.js'
import { streamAgentResponse } from '../_shared/sse.util.js'
import { reasonToStatus }      from '../_shared/reason.util.js'
import { parseChatMessages }   from '../_shared/parse.util.js'

const LOG = '[kairos:controller]'
const MAX_RECENT_CHAT_TURNS = 4

// Build conversation. Streams tokens/chart/status; the agent emits a DRAFT call in `done`
// (unsaved). Persisting happens only on Generate → generateKairosCall.
export async function streamKairos(req, res) {
    const parsed = parseStreamBody(req.body)
    if (parsed.error) return res.status(400).json({ error: parsed.error })

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const { routingMode, currentPhase, model, reasoningEffort } = req.body ?? {}
            const lastMessage = parsed.messages?.at(-1)?.content ?? parsed.userPrompt ?? ''
            const routing = await resolveModel({ routingMode, agent: 'kairos', phase: currentPhase, model, reasoningEffort, lastMessage })

            // The user's open positions + P&L across paper/live/manual, so Kairos sees the same live
            // book Idea/Atlas do (best-effort — a broker hiccup just drops the block).
            const brokerContext = await brokerService.loadContext(req.user._id).catch(() => ({}))

            const result = await kairosAgentService.chatStream({
                messages:      parsed.messages,
                userPrompt:    parsed.userPrompt,
                chatState:     parsed.chatState ?? emptyKairosState(),
                accounts:      parsed.accounts,
                seed:          parsed.seed,
                brokerContext,
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

            // `call` here is a DRAFT for preview — the client shows it and lets the user Generate.
            // `scan_request` (bias + horizon constraints) routes the user to Argus to find a ticker.
            return {
                reply: result.reply,
                phase: result.phase ?? null,
                ...(result.call ? { call: result.call } : {}),
                ...(result.scanRequest ? { scan_request: result.scanRequest } : {}),
            }
        },
    })
}

// Generate: persist a drafted call. Binds the marked accounts (bank icon) + resolves the venue,
// runs the construction gate, saves. Returns the saved call or a gate reason.
export async function generateKairosCall(req, res) {
    try {
        const { call, accounts, mainAccountId, chat_state } = req.body ?? {}
        if (!call || typeof call !== 'object' || Array.isArray(call)) {
            return res.status(400).send({ error: 'call must be an object' })
        }
        const acctList = Array.isArray(accounts) ? accounts : []

        // Persist the build conversation + draft so the Calls-tab edit pencil can reopen the call in
        // chat with its history (parity with the update path — without this, a generated call saves
        // chat_state:null and re-editing it starts a blank chat).
        const result = await _finalizeCall(call, { userId: req.user._id, accounts: acctList, mainAccountId, chatState: chat_state })
        if (!result.ok) return res.status(400).send({ error: result.reason ?? 'generate_failed' })

        res.send(result.call)
    } catch (err) {
        logger.error(LOG, 'Failed to generate kairos call', err)
        res.status(500).send({ error: 'Failed to generate call' })
    }
}

// Edit in place (the Calls-tab edit pencil → Kairos chat → "Update call"). Two shapes:
//  • { call, accounts, mainAccountId, chat_state } → re-finalize the plan on the existing call
//    (venue-resolve → validate → re-normalize → re-arm the monitor). Parity with updateIdea.
//  • { chat_state } alone → progressive save of the build conversation mid-edit (no plan change).
export async function updateKairosCall(req, res) {
    try {
        const { id } = req.params
        const { call, accounts, mainAccountId, chat_state } = req.body ?? {}
        const userId  = req.user._id
        const isAdmin = req.user.isAdmin === true

        let result
        if (call && typeof call === 'object' && !Array.isArray(call)) {
            const acctList = Array.isArray(accounts) ? accounts : []
            result = await _finalizeCall(call, { userId, accounts: acctList, mainAccountId, updateId: id, chatState: chat_state })
        } else {
            result = await kairosService.patchKairosCall(id, { chat_state }, userId, isAdmin)
        }

        if (!result.ok) {
            const code = reasonToStatus(result.reason, 400)
            return res.status(code).send({ error: result.reason ?? 'update_failed' })
        }
        res.send(result.call ?? { ok: true })
    } catch (err) {
        logger.error(LOG, 'Failed to update kairos call', err)
        res.status(500).send({ error: 'Failed to update call' })
    }
}

// Act on a card. Readiness: confirm | edit | dismiss. In-position management (Phase 5):
// move_stop | take_partial | exit_now | let_run (accept the pending proposal); dismiss clears an
// in-position card without terminating the position.
const MANAGE_ACTIONS = ['move_stop', 'take_partial', 'exit_now', 'let_run']

export async function actOnKairosCall(req, res) {
    try {
        const { id }     = req.params
        const { action } = req.body ?? {}
        const userId  = req.user._id
        const isAdmin = req.user.isAdmin === true

        let result
        if (action === 'confirm')             result = await kairosHandoffService.confirmCall(id, userId, isAdmin)
        else if (action === 'edit')           result = await kairosHandoffService.editCall(id, userId, isAdmin)
        else if (action === 'dismiss')        result = await kairosHandoffService.dismissCall(id, userId, isAdmin)
        else if (action === 'reentry')        result = await kairosHandoffService.reviveCall(id, userId, isAdmin)
        else if (action === 'decline_reentry') result = await kairosHandoffService.declineReentry(id, userId, isAdmin)
        else if (MANAGE_ACTIONS.includes(action)) result = await kairosHandoffService.manageCall(id, userId, action, isAdmin)
        else return res.status(400).send({ error: 'action must be confirm | edit | dismiss | reentry | decline_reentry | move_stop | take_partial | exit_now | let_run' })

        if (!result.ok) {
            const code = reasonToStatus(result.reason, 400)
            return res.status(code).send({ error: result.reason ?? 'action_failed' })
        }
        res.send(result)
    } catch (err) {
        logger.error(LOG, 'actOnKairosCall failed:', err.message)
        res.status(500).send({ error: 'action_failed' })
    }
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

// Kairos track record — aggregate of closed calls' outcomes (Phase 5, slice 4).
export async function getKairosPerformance(req, res) {
    try {
        const result = await kairosService.getKairosPerformance(req.user._id, req.user.isAdmin === true)
        if (!result.ok) return res.status(500).send({ error: 'performance_failed' })
        res.send(result.performance)
    } catch (err) {
        logger.error(LOG, 'Failed to get kairos performance', err)
        res.status(500).send({ error: 'Failed to get performance' })
    }
}

// Single call (with its monitor_state.timeline) — the pop-out polls this for the live journal.
export async function getKairos(req, res) {
    try {
        const result = await kairosService.getKairosCall(req.params.id, req.user._id, req.user.isAdmin === true)
        if (!result.ok) {
            const code = reasonToStatus(result.reason, 500)
            return res.status(code).send({ error: result.reason ?? 'get_failed' })
        }
        res.send(result.call)
    } catch (err) {
        logger.error(LOG, 'Failed to get kairos call', err)
        res.status(500).send({ error: 'Failed to get call' })
    }
}

export async function deleteKairos(req, res) {
    try {
        const result = await kairosService.deleteKairosCall(req.params.id, req.user._id, req.user.isAdmin === true)
        if (!result.ok) {
            const code = reasonToStatus(result.reason, 400)
            return res.status(code).send({ error: result.reason ?? 'delete_failed' })
        }
        res.send({ ok: true })
    } catch (err) {
        logger.error(LOG, 'Failed to delete kairos call', err)
        res.status(500).send({ error: 'Failed to delete call' })
    }
}

// Structured Argus candidate seed (K3): a scan hand-off arrives as a typed object, not free text.
// Kept lean + string-only; unknown/absent → null. recommended_mode is a FE concern (pre-fills the
// mode chip) and is NOT part of the prompt seed.
export function _sanitizeSeed(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const s = k => (typeof raw[k] === 'string' && raw[k].trim() ? raw[k].trim() : null)
    const ticker = s('ticker')
    if (!ticker) return null   // a seed without a ticker is meaningless
    return { ticker: ticker.toUpperCase(), direction: s('direction'), thesis: s('thesis'), analysis: s('analysis') }
}

function parseStreamBody(body) {
    const { messages, userPrompt, chatState, accounts } = body ?? {}
    const trimmedPrompt = typeof userPrompt === 'string' ? userPrompt.trim() : ''
    const seed = _sanitizeSeed(body?.seed)

    let state = null
    if (chatState !== undefined && chatState !== null) {
        if (typeof chatState !== 'object' || Array.isArray(chatState)) return { error: 'chatState must be an object' }
        state = chatState
    }

    const acctList = Array.isArray(accounts) ? accounts.filter(a => a && typeof a === 'object') : []

    if (messages !== undefined && messages !== null) {
        if (!Array.isArray(messages)) return { error: 'messages must be an array' }
        // Empty messages with a userPrompt fallback is allowed here (as on the idea endpoint).
        if (messages.length === 0) {
            if (trimmedPrompt) return { userPrompt: trimmedPrompt, chatState: state, accounts: acctList, seed }
            return { error: 'messages must be a non-empty array' }
        }
        // Use the same strict validator as the idea/portfolio/scanner endpoints (was inlined here).
        const validated = parseChatMessages(messages)
        if (validated.error) return { error: validated.error }
        const trimmed = validated.messages.slice(-MAX_RECENT_CHAT_TURNS * 2)
        return { userPrompt: trimmedPrompt || undefined, messages: trimmed, chatState: state, accounts: acctList, seed }
    }

    if (trimmedPrompt) return { userPrompt: trimmedPrompt, chatState: state, accounts: acctList, seed }
    return { error: 'Request must include messages or userPrompt' }
}
