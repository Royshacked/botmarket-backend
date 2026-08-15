import { logger }              from '../../services/logger.service.js'
import { kairosAgentService, emptyKairosState, _finalizeCall } from '../../services/agents/kairos.agent.service.js'
import { kairosService }       from './kairos.service.js'
import { kairosHandoffService } from '../../services/kairos.handoff.service.js'
import { streamAgentResponse, sseAgentCallbacks } from '../_shared/sse.util.js'
import { sendReason }         from '../_shared/reason.util.js'
import { makeEntityController } from '../_shared/entityController.util.js'
import { parseStreamBody }    from '../_shared/parse.util.js'
import { getExperienceLevel } from '../../services/experience.service.js'
import { sanitizeScanSeed } from '../../services/scanSeed.util.js'

const LOG = '[kairos:controller]'

// Build conversation. Streams tokens/chart/status; the agent emits a DRAFT call in `done`
// (unsaved). Persisting happens only on Generate → generateKairosCall.
export async function streamKairos(req, res) {
    const parsed = parseStreamBody(req.body)
    if (parsed.error) return res.status(400).json({ error: parsed.error })
    // Kairos's own extra: the structured Argus candidate that opened this desk.
    const seed = _sanitizeSeed(req.body?.seed)

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const { model } = req.body ?? {}

            // The user's open positions + P&L across paper/live/manual, so Kairos sees the same live
            // book Idea/Atlas do (best-effort — a broker hiccup just drops the block).

            const result = await kairosAgentService.chatStream({
                audience:      await getExperienceLevel(req.user._id),
                messages:      parsed.messages,
                userPrompt:    parsed.userPrompt,
                chatState:     parsed.chatState ?? emptyKairosState(),
                accounts:      parsed.accounts,
                mainAccountId: parsed.mainAccountId,
                seed,
                model,
                userId:        req.user._id,
                signal,
                ...sseAgentCallbacks(sendEvent),
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
        // Construction-gate reasons are Kairos's own (`missing_*`, `invalid_*`) — nothing shared
        // claims them, so they fall through to a 400 carrying the slug.
        if (!result.ok) return sendReason(res, result.reason, { fallbackMessage: 'generate_failed' })

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

        let result
        if (call && typeof call === 'object' && !Array.isArray(call)) {
            const acctList = Array.isArray(accounts) ? accounts : []
            result = await _finalizeCall(call, { userId, accounts: acctList, mainAccountId, updateId: id, chatState: chat_state })
        } else {
            result = await kairosService.patchKairosCall(id, { chat_state }, userId)
        }

        if (!result.ok) return sendReason(res, result.reason, { fallbackMessage: 'update_failed' })
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

        let result
        if (action === 'confirm')             result = await kairosHandoffService.confirmCall(id, userId)
        else if (action === 'edit')           result = await kairosHandoffService.editCall(id, userId)
        else if (action === 'dismiss')        result = await kairosHandoffService.dismissCall(id, userId)
        else if (action === 'reentry')        result = await kairosHandoffService.reviveCall(id, userId)
        else if (action === 'decline_reentry') result = await kairosHandoffService.declineReentry(id, userId)
        else if (MANAGE_ACTIONS.includes(action)) result = await kairosHandoffService.manageCall(id, userId, action)
        else return res.status(400).send({ error: 'action must be confirm | edit | dismiss | reentry | decline_reentry | move_stop | take_partial | exit_now | let_run' })

        if (!result.ok) return sendReason(res, result.reason, { fallbackMessage: 'action_failed' })
        res.send(result)
    } catch (err) {
        logger.error(LOG, 'actOnKairosCall failed:', err.message)
        res.status(500).send({ error: 'action_failed' })
    }
}

// list / get / delete are the shared HTTP tier — the same moves every kind makes over the same
// crud. A call has no PATCH route: mid-edit chat-state saves ride updateKairosCall (below), which
// also has to decide between a plan rewrite and a conversation save.
const crud = makeEntityController({
    log: LOG, noun: 'call',
    service: {
        list:   (userId)     => kairosService.listKairosCalls(userId),
        get:    (id, userId) => kairosService.getKairosCall(id, userId),
        remove: (id, userId) => kairosService.deleteKairosCall(id, userId),
    },
})

export const listKairos  = crud.list
// Single call (with its monitor_state.timeline) — the pop-out polls this for the live journal.
export const getKairos   = crud.get
export const deleteKairos = crud.remove

// Kairos track record — aggregate of closed calls' outcomes (Phase 5, slice 4).
export async function getKairosPerformance(req, res) {
    try {
        const result = await kairosService.getKairosPerformance(req.user._id)
        if (!result.ok) return res.status(500).send({ error: 'performance_failed' })
        res.send(result.performance)
    } catch (err) {
        logger.error(LOG, 'Failed to get kairos performance', err)
        res.status(500).send({ error: 'Failed to get performance' })
    }
}

// Kept as a named export because the mode tests drive it directly. The parser itself is shared —
// see services/scanSeed.util.js for why, and for why `recommended_mode` is carried there but not
// used here (Kairos's lens is the caller's choice; the field only pre-fills a UI chip).
export const _sanitizeSeed = sanitizeScanSeed

