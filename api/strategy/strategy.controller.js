// HTTP handlers for the strategy desk (Pythia, the industry desk — rebuilt 2026-10-05): the streaming
// agent, and the industry views it answers (docs/design/pythia-industry-questions.md).
//
// The views are a BROADCAST — house documents with no owner — so nothing here filters by
// `req.user._id`. The READS are open to every signed-in user; the stream and publishing are admin-only,
// gated per route in strategy.routes. A trader's read carries the answers, not the review machinery.

import { strategyAgentService } from '../../services/agents/strategy.agent.service.js'
import { industryViewService }  from './industryView.service.js'
import { readSubIndustry, listSubIndustries, moneyFacts } from './industryData.service.js'
import { notifyIndustryChanged } from '../../services/industryNotify.service.js'
import { industryScreenService } from './industryScreen.service.js'
import { runScreen } from '../../services/industryScreenRun.service.js'
import { industryAssessmentService } from './industryAssessment.service.js'
import { pythiaCallsService } from './pythiaCalls.service.js'
import { readTimingRow } from './screenerData.service.js'
import { assessIndustry, structureOf } from '../../services/industryAssessmentRun.service.js'
import { streamAgentResponse, sseAgentCallbacks }  from '../_shared/sse.util.js'
import { routeFields }                             from '../../services/routing.util.js'
import { parseChatMessages }    from '../_shared/parse.util.js'
import { sendReason }           from '../_shared/reason.util.js'
import { makeHandle }           from '../_shared/handle.util.js'
import { logger }               from '../../services/logger.service.js'

const LOG = '[strategyCtrl]'
// Every handler below rides makeHandle: the log line and the route to the global handler for the
// throw nobody foresaw. (streamStrategy is streamAgentResponse's, which has its own error path on an
// open SSE stream.)
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
            return { reply: result.reply, phase: result.phase ?? null, views: result.views ?? [], assessments: result.assessments ?? [], ...routeFields(result, req.user.role) }
        },
    })
}


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

/**
 * One sub-industry: its measurements (and what answers it) plus the house's view. An admin gets the
 * revision trail and the monitor state; a trader gets the answers — the trail carries internal notes
 * ("answer refused at publish — …") and the bookkeeping is the desk's.
 */
export const getIndustry = _handle('getIndustry', async (req, res) => {
    const bundle = await readSubIndustry(req.params.code)
    if (!bundle) return sendReason(res, 'unknown_industry', { overrides: VIEW_REASONS })
    const view = await industryViewService.getView(bundle.sub.code)
    res.json({ ...bundle, view: req.user?.role === 'admin' ? view : forTraders(view) })
})

/** A view without its revision trail and monitor bookkeeping. Pure. */
export function forTraders(view) {
    if (!view) return view
    const { revisions, monitor, ...rest } = view   // eslint-disable-line no-unused-vars -- dropped on purpose
    return { ...rest, next_review: monitor?.next_check_at ?? null }
}

// ─── The weekly industry screen (docs/design/industry-screener.md) ──────────

/**
 * The latest published screen: every sub-industry's verdict (trade or not, horizon) and why. `null`
 * (200) before the first one — not a 404: every board load asks, and "none yet" is not an error.
 */
export const getScreen = _handle('getScreen', async (req, res) => {
    res.json(await industryScreenService.latestScreen() ?? null)
})

/**
 * Run the screen now on the latest complete engine run (admin). `force` reruns a run date that already
 * has a screen. Answers when the screen is published — several minutes of research.
 */
export const runScreenNow = _handle('runScreenNow', async (req, res) => {
    const r = await runScreen(undefined, { force: req.body?.force === true })
    res.status(r.ok ? 200 : 409).json(r)
})

/** Publish a reviewed draft (the chat preview's Publish). Checked against the measured numbers. */
export const publishIndustry = _handle('publishIndustry', async (req, res) => {
    const bundle = await readSubIndustry(req.params.code)
    if (!bundle) return sendReason(res, 'unknown_industry', { overrides: VIEW_REASONS })
    await industryViewService.seedMissing([bundle.sub])
    const r = await industryViewService.publishView(bundle.sub.code, req.body ?? {}, bundle.answering, { note: req.body?.summary ?? null })
    if (!r.ok) return sendReason(res, r.reason, { overrides: VIEW_REASONS, fallback: 500, ...(r.detail ? { extra: { detail: r.detail } } : {}) })
    if (r.changed) notifyIndustryChanged(r.doc, r.changed).catch(err => logger.warn(LOG, 'industry card failed (view is published)', err.message))
    res.json(r.doc)
})

// ─── Assessments (docs/design/pythia-assessment.md, build step 1) ───────────

const ASSESS_REASONS = {
    bad_assessment: [422, 'The assessment does not hold up — see detail'],
    unknown_industry: [404, 'Unknown GICS sub-industry'],
}

/** Every published assessment (no trail), and the track record of the calls behind them. Read by everyone. */
export const listAssessments = _handle('listAssessments', async (req, res) => {
    const [assessments, record] = await Promise.all([industryAssessmentService.listAssessments(), pythiaCallsService.trackRecord()])
    res.json({ assessments, record })
})

/** One sub-industry's assessment, or null; the revision trail for admins only (it carries internal notes). */
export const getAssessment = _handle('getAssessment', async (req, res) => {
    const bundle = await readSubIndustry(req.params.code)
    if (!bundle) return sendReason(res, 'unknown_industry', { overrides: ASSESS_REASONS })
    const doc = await industryAssessmentService.getAssessment(bundle.sub.code)
    res.json(req.user?.role === 'admin' ? doc : withoutTrail(doc))
})

/** An assessment without its revision trail. Pure. */
export function withoutTrail(doc) {
    if (!doc) return doc ?? null
    const { revisions, ...rest } = doc   // eslint-disable-line no-unused-vars -- dropped on purpose
    return rest
}

/** Publish a reviewed <industry_assessment> draft from the chat preview (admin). */
export const publishAssessment = _handle('publishAssessment', async (req, res) => {
    const bundle = await readSubIndustry(req.params.code)
    if (!bundle) return sendReason(res, 'unknown_industry', { overrides: ASSESS_REASONS })
    const [{ row }, view] = await Promise.all([readTimingRow(bundle.sub.code), industryViewService.getView(bundle.sub.code)])
    const r = await industryAssessmentService.publishAssessment({ ...(req.body ?? {}), industry: bundle.sub.code },
        { sub: bundle.sub, row, money: moneyFacts(bundle.answering), structure: structureOf(view), recordCall: pythiaCallsService.recordCall, source: 'chat' })
    if (!r.ok) return sendReason(res, r.reason, { overrides: ASSESS_REASONS, fallback: 500, ...(r.detail ? { extra: { detail: r.detail } } : {}) })
    res.json({ ...r.doc, call: r.call ?? null })
})

/**
 * Assess one sub-industry now, headless (admin) — several minutes of research. It runs as the admin, so
 * the spend is booked and returned as `cost_usd`: the number the weekly cap is set from.
 */
export const assessNow = _handle('assessNow', async (req, res) => {
    const r = await assessIndustry(req.params.code, { userId: req.user._id })
    const status = r.ok ? 200 : r.outcome === 'unknown_industry' ? 404 : r.outcome === 'error' ? 500 : 422
    res.status(status).json(r)
})

/** The forward log: the latest calls with their grades (everyone). */
export const listCalls = _handle('listCalls', async (req, res) => {
    res.json(await pythiaCallsService.listCalls({ limit: parseInt(req.query?.limit, 10) || 100 }))
})
