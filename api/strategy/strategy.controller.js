// HTTP handlers for the strategy desk (Pythia): the streaming top-down agent + the tilt publication
// log.
//
// The tilt is a BROADCAST — one house view, no owner — so these routes are deliberately NOT
// owner-scoped the way coverage's are. `requireAuth` still gates them (you must be signed in to read
// or publish the view), but nothing here filters by `req.user._id`, and that asymmetry is the point:
// scoping a house view per user would quietly turn it into eleven private opinions.

import { tiltService }          from './tilt.service.js'
import { strategyAgentService } from '../../services/agents/strategy.agent.service.js'
import { diffStances }          from '../../monitoring/tilt.assess.js'
import { notifyTiltChanged }    from '../../services/tiltNotify.service.js'
import { streamAgentResponse, sseAgentCallbacks }  from '../_shared/sse.util.js'
import { parseChatMessages }    from '../_shared/parse.util.js'
import { logger }               from '../../services/logger.service.js'

const LOG = '[strategyCtrl]'

// Streaming top-down chat → emits a <tilt> draft (returned for preview; POST /tilt publishes it).
export async function streamStrategy(req, res) {
    const { messages, userPrompt, model, chatState } = req.body ?? {}
    if (messages !== undefined && messages !== null) {
        const v = parseChatMessages(messages)
        if (v.error) return res.status(400).json({ error: v.error })
    }
    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const result = await strategyAgentService.chatStream({
                messages,
                userPrompt,
                chatState: (chatState && typeof chatState === 'object') ? chatState : {},
                model,
                userId: req.user._id,
                signal,
                ...sseAgentCallbacks(sendEvent),
                onPhase:     phase => sendEvent('phase',     { phase }),
            })
            return { reply: result.reply, phase: result.phase ?? null, ...(result.tilt ? { tilt: result.tilt } : {}) }
        },
    })
}

// ─── The tilt publication log ─────────────────────────────────────────────────

const PUBLISH_REASONS = {
    no_usable_rows:            [400, 'No usable sector stances — every row was missing a recognised sector'],
    stance_contradicts_weight: [422, 'A stance contradicts its active weight'],
    not_found:                 [404, 'No such view'],
}

function _fail(res, result, fallback = 'Request failed') {
    const [status, message] = PUBLISH_REASONS[result?.reason] ?? [500, fallback]
    return res.status(status).json({ error: message, ...(result?.detail ? { detail: result.detail } : {}) })
}

/** The house view in force. Null is a legitimate answer — the desk may simply not have published yet. */
export async function getCurrentTilt(req, res) {
    const doc = await tiltService.getCurrentTilt(req.query?.benchmark || 'SPX')
    res.json(doc)
}

export async function listTilts(req, res) {
    const limit = Math.min(Number(req.query?.limit) || 24, 100)
    res.json(await tiltService.listTilts({ benchmark: req.query?.benchmark || 'SPX', limit }))
}

export async function getTilt(req, res) {
    const result = await tiltService.getTiltById(req.params.id)
    if (!result.ok) return _fail(res, result, 'Could not read the view')
    res.json(result.doc)
}

/**
 * Publish a new house view, superseding the previous one.
 *
 * The diff against what was in force is computed BEFORE publishing and drives the cards, so a
 * reaffirming republish tells nobody anything. Notification is fire-and-forget: the view is already
 * stored by then, and a delivery failure must not report the publish as failed.
 */
export async function publishTilt(req, res) {
    const benchmark = req.body?.benchmark || 'SPX'
    const previous  = await tiltService.getCurrentTilt(benchmark)

    const result = await tiltService.publishTilt(req.body ?? {}, { note: req.body?.note ?? null })
    if (!result.ok) return _fail(res, result, 'Could not publish the view')

    const changes = diffStances(previous, result.doc)
    notifyTiltChanged(result.doc, changes)
        .catch(err => logger.warn(LOG, 'tilt notify failed (view is published)', err.message))

    logger.info(LOG, 'view published', { id: result.doc.id, rows: result.doc.tilts.length, changed: changes.length })
    res.status(201).json({ ...result.doc, changed: changes })
}

/** Edit a stored view in place — a correction, not a new publication (no supersede, no card). */
export async function updateTilt(req, res) {
    const result = await tiltService.updateTilt(req.params.id, req.body ?? {})
    if (!result.ok) return _fail(res, result, 'Could not update the view')
    res.json(result.doc)
}

/** Stand the desk down for this benchmark. The trail is kept — a retired view is archived, not deleted. */
export async function retireTilt(req, res) {
    const result = await tiltService.retireTilt(req.params.id)
    if (!result.ok) return _fail(res, result, 'Could not retire the view')
    res.json(result.doc)
}
