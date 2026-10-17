// Prometheus's commits, run against the SESSION (unified-chat plan phase 8, K2).
//
// The draft is read from Prometheus's agentState — never from the client — and handed to the SAME service the
// coverage routes use (api/analyst/coverageCommit.service.js). The action contract is mentor.actions.js's.
//
// HOUSE COVERAGE IS AN ADMIN WRITE. The routes hold it with requireAdmin; the session route has no such gate, so
// every action here holds it itself. A trader talks to Prometheus and reads the draft — only an admin saves it.
//
// ONLY A STANDING DRAFT IS SAVED. The draft is also the conversation's SUBJECT (a revise seeds it with the thesis in
// the book, and it is fed back as the draft-so-far), so a turn without a <coverage> block cannot clear it — it
// withdraws only the right to save it (`standing`, analystNextState; agentUtils.buildStandingProposalRule).

import { coverageCommit as defaultCommit } from '../../../api/analyst/coverageCommit.service.js'
import { COVERAGE_REASONS } from '../../../api/analyst/coverageReasons.js'

const _sym = (v) => String(v ?? '').trim().toUpperCase()
const editingId = (state) => (state?.editing?.kind === 'coverage' ? String(state.editing.entityId) : null)
const proposal  = (state) => (state?.standing === true && state?.draft && typeof state.draft === 'object' ? state.draft : null)

export function makeAnalystActions({ commit = defaultCommit } = {}) {
    return {
        /** Initiate coverage on the draft's name — revised instead when the name is already covered. */
        async initiate({ user, state }) {
            if (user?.role !== 'admin') return { reason: 'forbidden' }
            const draft = proposal(state)
            if (!draft) return { reason: 'nothing_to_commit' }
            if (editingId(state)) return { reason: 'not_new_coverage' }
            const out = await commit.initiateOrRevise(draft)
            if (!out.ok) return { reason: out.reason, ...(out.detail ? { extra: { detail: out.detail } } : {}) }
            return {
                result: { coverage: out.doc, revised: out.revised },
                seal:   { kind: 'coverage', entityIds: [out.doc.id], name: out.doc.symbol ?? null },
                after:  null,
            }
        },

        /** Revise the thesis being edited with the draft — only a draft about THAT name. */
        async update({ user, state }) {
            if (user?.role !== 'admin') return { reason: 'forbidden' }
            const id = editingId(state)
            const draft = proposal(state)
            if (!id || !draft) return { reason: 'nothing_to_commit' }
            // Editing AAPL, Prometheus drafted MSFT: saving it would overwrite AAPL's thesis with another company's.
            if (state.editingSymbol && _sym(draft.symbol) !== _sym(state.editingSymbol)) return { reason: 'wrong_symbol' }
            const out = await commit.revise(id, { ...draft, ...commit.REMODEL })
            if (!out.ok) return { reason: out.reason, ...(out.detail ? { extra: { detail: out.detail } } : {}) }
            return {
                result: { coverage: out.doc, revised: true },
                seal:   { kind: 'coverage', entityIds: [id], name: out.doc?.symbol ?? null, onlyIfEditing: true },
                after:  null,
            }
        },

        /** Stop revising a thesis without saving it. */
        async later({ state }) {
            if (!editingId(state)) return { reason: 'nothing_to_commit' }
            return { result: {}, after: null }
        },
    }
}

export const analystActions = makeAnalystActions()

// Prometheus's refusals, in its own words — the coverage routes' table, and the session's own.
const ANALYST_REASONS = {
    ...COVERAGE_REASONS,
    not_new_coverage: [409, 'This thesis is being revised — update it instead'],
    wrong_symbol:     [409, 'The draft is about another company than the thesis being revised'],
}
export const analystReason = (reason) => ANALYST_REASONS[reason] ?? null
