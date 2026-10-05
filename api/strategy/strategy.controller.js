// HTTP handlers for the strategy desk (Pythia): the streaming top-down agent + the tilt publication
// log.
//
// The tilt is a BROADCAST — one house view, no owner — so nothing here filters by `req.user._id`,
// and that is the point: scoping a house view per user would quietly turn it into eleven private
// opinions. (Coverage is house-owned the same way.) The router gates the whole desk `requireAdmin`
// — see strategy.routes.

import { tiltService } from './tilt.service.js'
import { industryViewService } from './industryView.service.js'
import { readSubIndustry, listSubIndustries } from './industryData.service.js'
import { seriesForTilt }          from './tiltSeries.service.js'
import { readBoardCalls }         from './channelCalls.service.js'
import { strategyAgentService } from '../../services/agents/strategy.agent.service.js'
import { diffStances }          from '../../monitoring/tilt.assess.js'
import { notifyTiltChanged }    from '../../services/tiltNotify.service.js'
import { runHouseScan }         from '../../services/houseScan.service.js'
import { streamAgentResponse, sseAgentCallbacks }  from '../_shared/sse.util.js'
import { routeFields }                             from '../../services/routing.util.js'
import { parseChatMessages }    from '../_shared/parse.util.js'
import { sendReason }           from '../_shared/reason.util.js'
import { makeHandle }           from '../_shared/handle.util.js'
import { logger }               from '../../services/logger.service.js'

const LOG = '[strategyCtrl]'
// Every handler below rides makeHandle. None of them caught before — tilt.service answers
// `{ ok, reason }` for everything it can foresee — so the wrapper changes no answer the client
// sees; it is the log line and the route to the global handler for the throw nobody foresaw, which
// Express 4 would otherwise leave as a request that never ends. (streamStrategy is
// streamAgentResponse's, which has its own error path on an open SSE stream.)
const _handle = makeHandle(LOG)

// Streaming industry-desk chat → <industry_view> drafts (returned for preview; POST /industries/:code
// publishes one).
export async function streamStrategy(req, res) {
    const { messages: rawMessages, userPrompt, model, chatState } = req.body ?? {}
    let messages
    if (rawMessages != null) {
        const v = parseChatMessages(rawMessages)
        if (v.error) return res.status(400).json({ error: v.error })
        messages = v.messages
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
            // The <industry_view> drafts, for preview — publishing is POST /industries/:code.
            // …plus route / routeSymbol / opening: the user asked to be sent to another desk (routing.util).
            return { reply: result.reply, phase: result.phase ?? null, views: result.views ?? [], ...routeFields(result, req.user.role) }
        },
    })
}

// ─── The tilt publication log ─────────────────────────────────────────────────

/**
 * The refusals THIS desk owns, in the shape reason.util takes as `overrides`.
 *
 * `not_found` is deliberately absent: it is a shared reason and the shared table already answers it
 * 404. This module used to redefine it here, in a private lookup that `_fail` read directly — which
 * is the same drift the reason table exists to prevent, wearing a different shape. It also answered
 * without the `reason` slug every other route sends, so a client had to read the prose to tell one
 * refusal from another. reasonStatus.test.js now fails on a controller-owned table like that.
 */
const PUBLISH_REASONS = {
    no_usable_rows:            [400, 'No usable sector stances — every row was missing a recognised sector'],
    stance_contradicts_weight: [422, 'A stance contradicts its active weight'],
}

/** `detail` is this desk's own: which rows contradicted themselves, so the author can fix them. */
function _fail(res, result, fallback = 'Request failed') {
    return sendReason(res, result?.reason, {
        overrides: PUBLISH_REASONS,
        fallback: 500,
        fallbackMessage: fallback,
        ...(result?.detail ? { extra: { detail: result.detail } } : {}),
    })
}

/** The house view in force. Null is a legitimate answer — the desk may simply not have published yet. */
export const getCurrentTilt = _handle('getCurrentTilt', async (req, res) => {
    const doc = await tiltService.getCurrentTilt(req.query?.benchmark || 'SPX')
    res.json(doc)
})

/**
 * The LINE behind each stance on the view in force — `{ [bucket]: [{t, v}] }`, rebased to 100 at
 * the call, so its last point is the relative return the contribution is computed from.
 *
 * A SEPARATE read from the view itself, deliberately. The board must paint on the numbers it
 * already has; the lines are an ornament that arrives when the bars do, and folding them into
 * `/tilt/current` would put a dozen range fetches in front of every read of the house view.
 * `{}` is a legitimate answer — no published view, or a provider having a bad morning.
 */
export const getTiltSeries = _handle('getTiltSeries', async (req, res) => {
    const doc = await tiltService.getCurrentTilt(req.query?.benchmark || 'SPX')
    res.json(doc ? await seriesForTilt(doc) : {})
})

/**
 * The view in force's channel calls with their latest marks, and the desk's record — a separate light
 * read beside the view, like the series: the board paints without it. `{ record: null, calls: {} }`
 * when there is no view or no ledger.
 */
export const getTiltCalls = _handle('getTiltCalls', async (req, res) => {
    const doc = await tiltService.getCurrentTilt(req.query?.benchmark || 'SPX')
    res.json(doc ? await readBoardCalls(doc) : { record: null, calls: {} })
})

export const listTilts = _handle('listTilts', async (req, res) => {
    const limit = Math.min(Number(req.query?.limit) || 24, 100)
    res.json(await tiltService.listTilts({ benchmark: req.query?.benchmark || 'SPX', limit }))
})

export const getTilt = _handle('getTilt', async (req, res) => {
    const result = await tiltService.getTiltById(req.params.id)
    if (!result.ok) return _fail(res, result, 'Could not read the view')
    res.json(result.doc)
})

/**
 * Publish a new house view, superseding the previous one.
 *
 * The diff against what was in force is computed BEFORE publishing and drives the cards, so a
 * reaffirming republish tells nobody anything. Notification is fire-and-forget: the view is already
 * stored by then, and a delivery failure must not report the publish as failed.
 */
export const publishTilt = _handle('publishTilt', async (req, res) => {
    const benchmark = req.body?.benchmark || 'SPX'
    const previous  = await tiltService.getCurrentTilt(benchmark)

    const result = await tiltService.publishTilt(req.body ?? {}, { note: req.body?.note ?? null })
    if (!result.ok) return _fail(res, result, 'Could not publish the view')

    const changes = diffStances(previous, result.doc)
    notifyTiltChanged(result.doc, changes)
        .catch(err => logger.warn(LOG, 'tilt notify failed (view is published)', err.message))

    // Trigger the admin pipeline: Argus house scan → research queue → Prometheus.
    // Fire-and-forget — the view is already stored; a scan failure must not un-publish it.
    runHouseScan(result.doc)
        .catch(err => logger.warn(LOG, 'house scan trigger failed (view is published)', err.message))

    logger.info(LOG, 'view published', { id: result.doc.id, rows: result.doc.tilts.length, changed: changes.length })
    res.status(201).json({ ...result.doc, changed: changes })
})

/** Edit a stored view in place — a correction, not a new publication (no supersede, no card). */
export const updateTilt = _handle('updateTilt', async (req, res) => {
    const result = await tiltService.updateTilt(req.params.id, req.body ?? {})
    if (!result.ok) return _fail(res, result, 'Could not update the view')
    res.json(result.doc)
})

/** Stand the desk down for this benchmark. The trail is kept — a retired view is archived, not deleted. */
export const retireTilt = _handle('retireTilt', async (req, res) => {
    const result = await tiltService.retireTilt(req.params.id)
    if (!result.ok) return _fail(res, result, 'Could not retire the view')
    res.json(result.doc)
})


// ─── The industry views (Pythia, rebuilt 2026-10-05) ─────────────────────────

const VIEW_REASONS = {
    bad_draft: [422, 'The view does not hold up — see detail'],
    unknown_industry: [404, 'Unknown GICS sub-industry'],
}

/**
 * Every sub-industry: the house's answer where there is one, beside the engine's measured first read.
 * The two are separate on purpose — a pending industry still shows what was measured.
 */
export const listIndustries = _handle('listIndustries', async (req, res) => {
    const [measured, views] = await Promise.all([listSubIndustries(), industryViewService.listViews()])
    const byCode = new Map(views.map(v => [v.code, v]))
    res.json(measured.map(m => {
        const v = byCode.get(m.code)
        return { ...m, view: v ? { status: v.status, demand: v.demand, economics: v.economics, cycle: v.cycle,
            summary: v.summary, reopen_if: v.reopen_if, next_review: v.monitor?.next_check_at ?? null, updated_at: v.updated_at } : null }
    }))
})

/** One sub-industry: its measurements (and what answers it) plus the house's view with its trail. */
export const getIndustry = _handle('getIndustry', async (req, res) => {
    const bundle = await readSubIndustry(req.params.code)
    if (!bundle) return sendReason(res, 'unknown_industry', { overrides: VIEW_REASONS })
    res.json({ ...bundle, view: await industryViewService.getView(bundle.sub.code) })
})

/** Publish a reviewed draft (the chat preview's Publish). Checked against the measured numbers. */
export const publishIndustry = _handle('publishIndustry', async (req, res) => {
    const bundle = await readSubIndustry(req.params.code)
    if (!bundle) return sendReason(res, 'unknown_industry', { overrides: VIEW_REASONS })
    await industryViewService.seedMissing([bundle.sub])
    const r = await industryViewService.publishView(bundle.sub.code, req.body ?? {}, bundle.answering, { note: req.body?.summary ?? null })
    if (!r.ok) return sendReason(res, r.reason, { overrides: VIEW_REASONS, fallback: 500, ...(r.detail ? { extra: { detail: r.detail } } : {}) })
    res.json(r.doc)
})
