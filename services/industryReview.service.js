// A headless Pythia review of ONE sub-industry — the industry desk's counterpart of coverageRefresh.
//
// Runs the desk with no user and no conversation, focused on one GICS sub-industry, and publishes what it
// answers. Called by the industry-view monitor for every view that is due (unanswered, scheduled, or
// brought forward by a trigger). Never throws: the caller is a monitor tick.
//
//   • a block for the industry       → published (checked against the numbers; a departure from a
//                                       code grade without its argument is refused, and the refusal is
//                                       recorded so the next review sees it)
//   • no block                        → recorded as a pass with the model's last paragraph as the
//                                       reason; the clock restarts
//
// A house run books no token spend against anyone (resolveAgentStream records usage per user only),
// the same known gap as the coverage re-model.

import { strategyAgentService } from './agents/strategy.agent.service.js'
import { industryViewService } from '../api/strategy/industryView.service.js'
import { readSubIndustry } from '../api/strategy/industryData.service.js'
import { notifyIndustryChanged } from './industryNotify.service.js'
import { withTimeout } from './timeout.util.js'
import { logger } from './logger.service.js'

const LOG = '[industryReview]'
export const REVIEW_TIMEOUT_MS = 10 * 60 * 1000
const PASS_MAX = 400

const _deps = {
    read:    (code) => readSubIndustry(code),
    run:     (args) => strategyAgentService.chatStream(args),
    publish: (code, draft, node, opts) => industryViewService.publishView(code, draft, node, opts),
    pass:    (code, reason, cyclical) => industryViewService.recordPass(code, reason, cyclical),
    notify:  (doc, changed) => notifyIndustryChanged(doc, changed),
}
export function _setDeps(d) { Object.assign(_deps, d) }

/** The headless instruction for one review. Pure. */
export function _reviewPrompt(sub, reason) {
    return `Review GICS sub-industry ${sub.code} (${sub.name}). Read its numbers (get_industry_metrics), its companies `
        + `(get_industry_companies) and the standing answer (get_industry_view), research what the numbers cannot `
        + `see, and answer the three questions. ${reason ? `It is due because: ${reason}. ` : ''}`
        + `End with exactly one <industry_view> block for ${sub.code}.`
}

/** The last paragraph of a reply, as the reason a review produced nothing. Pure. */
export function _lastParagraph(reply) {
    const parts = String(reply ?? '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
    const one = (parts.at(-1) ?? '').replace(/\s+/g, ' ')
    return one ? (one.length > PASS_MAX ? one.slice(0, PASS_MAX - 1) + '…' : one) : null
}

/**
 * Review one sub-industry and publish the answer. → `{ ok, outcome }`, outcome one of
 * published | refused | pass | unknown | error.
 */
export async function reviewIndustry(code, reason = null, deps = _deps) {
    try {
        const bundle = await deps.read(code)
        if (!bundle) return { ok: false, outcome: 'unknown' }
        const { sub, answering } = bundle
        const cyclical = Boolean(answering?.q3?.cyclical)
        const result = await withTimeout(deps.run({
            messages: [], userPrompt: _reviewPrompt(sub, reason),
            chatState: { industry: sub.code, ...(reason ? { review_reason: reason } : {}) },
            userId: null,
            onToken: () => {}, onToolStart: () => {}, onReasoning: () => {}, onPhase: () => {},
        }), REVIEW_TIMEOUT_MS, `industry review ${sub.code}`)

        const draft = (result?.views ?? []).find(v => v.industry === sub.code || v.industry.toLowerCase() === sub.name.toLowerCase())
        if (!draft) {
            const why = _lastParagraph(result?.reply) ?? 'the review produced no answer'
            await deps.pass(sub.code, why, cyclical)
            logger.info(LOG, 'review passed', { code: sub.code })
            return { ok: true, outcome: 'pass' }
        }
        const r = await deps.publish(sub.code, draft, answering, { note: reason ? `Review (${reason})` : null })
        if (!r.ok) {
            // The desk's answer did not hold up (most often: a departure from a measured grade with no
            // argument). Recorded on the trail so the next review is shown why; the clock still restarts.
            await deps.pass(sub.code, `answer refused at publish — ${r.detail ?? r.reason}`, cyclical)
            logger.warn(LOG, 'review answer refused', { code: sub.code, reason: r.reason, detail: r.detail })
            return { ok: false, outcome: 'refused' }
        }
        if (r.changed) await deps.notify(r.doc, r.changed)
        logger.info(LOG, 'review published', { code: sub.code, changed: Boolean(r.changed) })
        return { ok: true, outcome: 'published', changed: r.changed ?? null }
    } catch (err) {
        logger.warn(LOG, 'review failed', { code, error: err.message })
        return { ok: false, outcome: 'error' }
    }
}
