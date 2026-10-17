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

import { coverageCommit as defaultCommit, REMODEL } from '../../../api/analyst/coverageCommit.service.js'
import { COVERAGE_REASONS } from '../../../api/analyst/coverageReasons.js'

const _sym = (v) => String(v ?? '').trim().toUpperCase()
const editingId = (state) => (state?.editing?.kind === 'coverage' ? String(state.editing.entityId) : null)
const proposal  = (state) => (state?.standing === true && state?.draft && typeof state.draft === 'object' ? state.draft : null)
const refusal   = (out) => ({ reason: out.reason, ...(out.detail ? { extra: { detail: out.detail } } : {}) })
// A standing draft about ANOTHER company than the thesis being revised (phase 8d CR): a research seed sent mid-edit,
// say. It is not an edit of that thesis — Update refuses it (wrong_symbol) — so it is new work: Initiate takes it and
// Later keeps it rather than throwing it away with the edit.
const elsewhere = (state, draft) => !!state?.editingSymbol && !!draft && _sym(draft.symbol) !== _sym(state.editingSymbol)

export function makeAnalystActions({ commit = defaultCommit } = {}) {
    return {
        /** Initiate coverage on the draft's name — revised instead when the name is already covered. */
        async generate({ user, state }) {
            if (user?.role !== 'admin') return { reason: 'forbidden' }
            const draft = proposal(state)
            if (!draft) return { reason: 'nothing_to_commit' }
            if (editingId(state) && !elsewhere(state, draft)) return { reason: 'not_new' }
            const out = await commit.initiateOrRevise(draft)
            if (!out.ok) return refusal(out)
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
            const out = await commit.revise(id, { ...draft, ...REMODEL })
            if (!out.ok) return refusal(out)
            return {
                result: { coverage: out.doc, revised: true },
                seal:   { kind: 'coverage', entityIds: [id], name: out.doc?.symbol ?? null, onlyIfEditing: true },
                after:  null,
            }
        },

        /** Stop revising a thesis without saving it — a standing draft about another company stays, as new work. */
        async later({ state }) {
            if (!editingId(state)) return { reason: 'nothing_to_commit' }
            const draft = proposal(state)
            if (elsewhere(state, draft)) return { result: {}, after: { active_symbol: _sym(draft.symbol), draft, standing: true } }
            return { result: {}, after: null }
        },
    }
}

export const analystActions = makeAnalystActions()

// Prometheus's refusals, in its own words — the coverage routes' table, and the session's own.
export const ANALYST_REASONS = {
    ...COVERAGE_REASONS,
    wrong_symbol: [409, 'The draft is about another company than the thesis being revised'],
}
