// Pythia's commit, run against the SESSION (unified-chat plan phase 8, K2).
//
// One conversation can leave several <industry_view> drafts on the table, each published on its own. The draft is
// read from Pythia's agentState by its industry code — never from the client — and handed to the SAME service the
// route uses (api/strategy/industryPublish.service.js). The action contract is mentor.actions.js's; Pythia's own
// verb is `publish`, and it has no `later` (a view is never reopened for editing here).
//
// THE SEAL WAITS FOR THE LAST DRAFT. The conversation produced all of them, so it moves onto every view it
// published — once nothing is left to publish. Sealing after the first would clear the state and lose the rest.
// Views published from a batch the user then walks away from stay unsealed: their conversation stays in the
// session, which is where the user left it.
// (Pythia is an admin desk: the session's speaker rule already holds every press here to an admin.)

import { publishIndustry as defaultPublish } from '../../../api/strategy/industryPublish.service.js'
import { VIEW_REASONS } from '../../../api/strategy/viewReasons.js'

const _code = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function makeStrategyActions({ publish = defaultPublish } = {}) {
    return {
        /** Publish one draft — `args.industry` names which. */
        async publish({ state, args }) {
            const code   = _code(args?.industry)
            const drafts = Array.isArray(state?.draftViews) ? state.draftViews : []
            const draft  = code ? drafts.find(v => v?.industry === code) : null
            if (!draft) return { reason: 'nothing_to_commit' }
            const out = await publish(code, draft)
            if (!out.ok) return { reason: out.reason, ...(out.detail ? { extra: { detail: out.detail } } : {}) }

            const rest      = drafts.filter(v => v?.industry !== code)
            const published = [...new Set([...(state.published ?? []), out.sub.code])]
            if (rest.length) return { result: { view: out.doc }, after: { ...state, draftViews: rest, published } }
            return {
                result: { view: out.doc },
                seal:   { kind: 'industry_view', entityIds: published, name: published.length === 1 ? (out.sub.name ?? null) : null },
                after:  null,
            }
        },
    }
}

export const strategyActions = makeStrategyActions()

// Pythia's refusals — the view routes' table.
export { VIEW_REASONS as STRATEGY_REASONS }
