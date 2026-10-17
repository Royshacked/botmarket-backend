// What saving coverage DOES — one service for the coverage routes and Prometheus's session actions (unified-chat
// plan phase 8, K2), so the drawer's button and the route behind the old panel commit the same way.
//
//   revise            a thesis revised in place, then the cards asking for it closed (PUT /analyst/coverage/:id)
//   initiateOrRevise  a draft initiated — or, when the name is already covered (any status: a retired thesis is
//                     revised, never initiated twice), revised as a remodel. The panel did this fallback itself.
//
// Refusals answer `{ ok:false, reason, detail? }` on the coverage vocabulary; the callers judge what to say.

import { coverageService as defaultCoverage, revisionSummary } from './coverage.service.js'
import { resolveCardsFor as defaultResolveCards } from '../chat/chat.service.js'

// How a revision from a Prometheus conversation is recorded in the trail.
export const REMODEL = { revision_kind: 'remodel', revision_note: 'Coverage updated via Prometheus' }

export function makeCoverageCommit({ coverage = defaultCoverage, resolveCards = defaultResolveCards } = {}) {

    /**
     * THE WORK LANDED. Coverage writes do not go through makeEntityController, so the one seam that closes a card
     * when its ask is satisfied never saw them — a verdict card sat "still waiting on you" after the thesis it asked
     * for was revised. After the write, never before, and non-fatal (resolveCardsFor swallows its own failures). The
     * note is the revision's own account of what moved — the trail entry this write just appended.
     */
    async function revise(id, patch) {
        const result = await coverage.updateCoverage(id, patch)
        if (!result.ok) return result
        await resolveCards({ kind: 'coverage', id }, { outcome: 'revised', note: revisionSummary(result.doc?.revisions?.[0]) })
        return result
    }

    /** @returns {Promise<{ ok:false, reason:string, detail?:string } | { ok:true, doc:object, revised:boolean }>} */
    async function initiateOrRevise(draft) {
        const out = await coverage.initiateCoverage(draft)
        if (out.ok) return { ok: true, doc: out.doc, revised: false }
        // Covered already — the panel's stale list, or a retired thesis. The id says which one to revise.
        if (out.reason === 'already_covered' && out.id) {
            const rev = await revise(out.id, { ...draft, ...REMODEL })
            return rev.ok ? { ok: true, doc: rev.doc, revised: true } : rev
        }
        return out
    }

    return { revise, initiateOrRevise }
}

export const coverageCommit = makeCoverageCommit()
