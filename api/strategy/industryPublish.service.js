// Publishing an industry view — one service for the route (POST /strategy/industries/:code) and Pythia's session
// action (unified-chat plan phase 8, K2), so the drawer's Publish and the panel's commit the same way.
//
// The draft is checked against the measured numbers (industryViewService.publishView). It posts no card (Roy,
// 2026-10-24: "Pythia — stop posting cards"): her answers are read on the Forecasts board. Refusals answer
// `{ ok:false, reason, detail? }`; the callers judge what to say.

import { industryViewService as defaultViews } from './industryView.service.js'
import { readSubIndustry as defaultReadSub } from './industryData.service.js'

export function makeIndustryPublish({ views = defaultViews, readSub = defaultReadSub } = {}) {
    /** @returns {Promise<{ ok:false, reason:string, detail?:string } | { ok:true, doc:object, sub:object }>} */
    return async function publishIndustry(code, draft) {
        const bundle = await readSub(code)
        if (!bundle) return { ok: false, reason: 'unknown_industry' }
        await views.seedMissing([bundle.sub])
        const r = await views.publishView(bundle.sub.code, draft ?? {}, bundle.answering, { note: draft?.summary ?? null })
        if (!r.ok) return r
        return { ok: true, doc: r.doc, sub: bundle.sub }
    }
}

export const publishIndustry = makeIndustryPublish()
