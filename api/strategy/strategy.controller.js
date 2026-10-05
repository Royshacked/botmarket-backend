// HTTP handlers for the strategy desk (Pythia, the industry desk — rebuilt 2026-10-05): the streaming
// agent, and the industry views it answers (docs/design/pythia-industry-questions.md).
//
// The views are a BROADCAST — house documents with no owner — so nothing here filters by
// `req.user._id`. The READS are open to every signed-in user; the stream and publishing are admin-only,
// gated per route in strategy.routes. A trader's read carries the answers, not the review machinery.

import { strategyAgentService } from '../../services/agents/strategy.agent.service.js'
import { industryViewService }  from './industryView.service.js'
import { readSubIndustry, listSubIndustries } from './industryData.service.js'
import { notifyIndustryChanged } from '../../services/industryNotify.service.js'
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
            return { reply: result.reply, phase: result.phase ?? null, views: result.views ?? [], ...routeFields(result, req.user.role) }
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
