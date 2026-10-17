// Publishing an industry view — one service for the route (POST /strategy/industries/:code) and Pythia's session
// action (unified-chat plan phase 8, K2), so the drawer's Publish and the panel's commit the same way.
//
// The draft is checked against the measured numbers (industryViewService.publishView); a view whose answer CHANGED
// posts the industry card. Refusals answer `{ ok:false, reason, detail? }`; the callers judge what to say.

import { industryViewService as defaultViews } from './industryView.service.js'
import { readSubIndustry as defaultReadSub } from './industryData.service.js'
import { notifyIndustryChanged as defaultNotify } from '../../services/industryNotify.service.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[industryPublish]'

// What a view refusal means — the route's and Pythia's session action's.
export const VIEW_REASONS = {
    bad_draft: [422, 'The view does not hold up — see detail'],
    unknown_industry: [404, 'Unknown GICS sub-industry'],
}

export function makeIndustryPublish({ views = defaultViews, readSub = defaultReadSub, notify = defaultNotify } = {}) {
    /** @returns {Promise<{ ok:false, reason:string, detail?:string } | { ok:true, doc:object, sub:object }>} */
    return async function publishIndustry(code, draft) {
        const bundle = await readSub(code)
        if (!bundle) return { ok: false, reason: 'unknown_industry' }
        await views.seedMissing([bundle.sub])
        const r = await views.publishView(bundle.sub.code, draft ?? {}, bundle.answering, { note: draft?.summary ?? null })
        if (!r.ok) return r
        if (r.changed) notify(r.doc, r.changed).catch(err => logger.warn(LOG, 'industry card failed (view is published)', err.message))
        return { ok: true, doc: r.doc, sub: bundle.sub }
    }
}

export const publishIndustry = makeIndustryPublish()
