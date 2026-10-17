// Mentor's commits and direct edits, run against the SESSION (unified-chat plan phase 8, K2/K3).
//
// The draft is read from Mentor's agentState — never from the client — and handed to the SAME services the setup
// routes use (setupCommit.commitSetup / armSetup, setupService.generateSetups). What each press means is Mentor's
// judgement and lives here; the route and the lock are shared (services/desks/act.js).
//
// THE ACTION CONTRACT — the same on every desk (services/desks/actions/*, phase 8a CR D1):
//   verbs      generate (a new entity) · update (the one being edited) · later (stop editing, nothing saved),
//              plus the desk's own (Mentor: generateAll, arm, leave)
//   answer     `{ reason, extra?, after? }` refused, or `{ result, seal?, after? }` done:
//     result   `{ <kind>: doc, ...extras }` — what the client shows; never a service's `ok`
//     seal     the entities this commit produced — the agent's turns move onto them (seal.js), in-line
//     after    the agent's state once the commit is done (undefined: leave it; null: clear it)
//   Everything refused is a refusal (`nothing_saved`, `extra.failed`), never a success with nothing in it.
//
// After a Generate Mentor's state is `{ generated }` — the setup exists but nothing watches it until it is armed,
// and that distinction is the whole reason the surface stops on "Arm it / Leave it waiting".

import { setupCommit as defaultCommit } from '../../../api/setups/setupCommit.service.js'
import { parseCommitArgs, parseIdeaAccounts } from '../../../api/_shared/parse.util.js'
import { draftVerdict } from '../../setupVerdict.js'
import { emptyMentorState } from '../../agents/mentor.agent.service.js'

const generatedOf = (doc) => ({ id: doc.id, asset: doc.asset ?? null, status: doc.status ?? null })
const editingId   = (state) => (state?.editing?.kind === 'setup' ? String(state.editing.entityId) : null)
const chatStateOf = (state) => ({ draft: state?.draft ?? null, coverage: state?.coverage ?? [] })
const setupName   = (doc) => (doc?.asset ? `${doc.asset} setup` : null)

export function makeMentorActions({ commit = defaultCommit } = {}) {
    return {
        /** Save the draft as a new setup — it then waits on Arm. */
        async generate({ user, state, args }) {
            const draft = state?.draft
            if (!draft) return { reason: 'nothing_to_commit' }
            if (editingId(state)) return { reason: 'not_new' }
            const { accounts, mainAccountId } = parseCommitArgs(args)
            if (!accounts.length) return { reason: 'no_venue' }
            const out = await commit.commitSetup(draft, { userId: user._id, accounts, mainAccountId, updateId: null, chatState: chatStateOf(state) })
            if (!out.ok) return { reason: out.reason }
            return {
                result: { setup: out.doc },
                seal:   { kind: 'setup', entityIds: [out.doc.id], name: setupName(out.doc) },
                after:  { ...emptyMentorState(), generated: generatedOf(out.doc) },
            }
        },

        /** Save the draft onto the setup being edited, in place — it satisfies the cards asking for it. */
        async update({ user, state, args }) {
            const id = editingId(state)
            if (!id || !state?.draft) return { reason: 'nothing_to_commit' }
            const { accounts, mainAccountId } = parseCommitArgs(args)
            if (!accounts.length) return { reason: 'no_venue' }
            const out = await commit.commitSetup(state.draft, { userId: user._id, accounts, mainAccountId, updateId: id, chatState: chatStateOf(state) })
            if (!out.ok) return { reason: out.reason }
            return {
                result: { setup: out.doc },
                seal:   { kind: 'setup', entityIds: [out.doc.id], name: setupName(out.doc), onlyIfEditing: true },
                after:  null,
            }
        },

        /** Save every plan of a multi-name build. Partial success is the contract: refused plans stay on the table. */
        async generateAll({ user, state, args }) {
            const byAsset = { ...(state?.drafts ?? {}), ...(state?.draft?.asset ? { [state.draft.asset]: state.draft } : {}) }
            const all = Object.values(byAsset)
            if (all.length < 2) return { reason: 'nothing_to_commit' }
            const { accounts, mainAccountId } = parseCommitArgs(args)
            if (!accounts.length) return { reason: 'no_venue' }
            const out = await commit.generateSetups(all, { userId: user._id, accounts, mainAccountId, chatState: chatStateOf(state) })
            if (out.reason) return { reason: out.reason, extra: { max: out.max ?? null } }
            const { saved, failed } = out
            if (!saved.length) return { reason: 'nothing_saved', extra: { failed } }
            const refused = Object.fromEntries(failed.filter(f => f.asset && byAsset[f.asset]).map(f => [f.asset, byAsset[f.asset]]))
            const left    = Object.values(refused)
            return {
                result: { setups: saved, failed },
                seal:   { kind: 'setup', entityIds: saved.map(d => d.id) },
                after:  {
                    ...emptyMentorState(),
                    // What was refused stays, by asset, so the next turn can fix it.
                    draft:        left[0] ?? null,
                    active_asset: left[0]?.asset ?? '',
                    drafts:       left.length > 1 ? refused : {},
                    generated:    generatedOf(saved[saved.length - 1]),
                },
            }
        },

        /** Arm the setup just generated — the gate re-runs in the service. */
        async arm({ user, state }) {
            const id = state?.generated?.id
            if (!id) return { reason: 'nothing_to_commit' }
            const out = await commit.armSetup(id, user._id)
            if (!out.ok) return { reason: out.reason }
            return { result: { setup: out.doc }, after: null }
        },

        /** Leave the generated setup waiting (unwatched) — the build is over either way. */
        async leave({ state }) {
            if (!state?.generated) return { reason: 'nothing_to_commit' }
            return { result: {}, after: null }
        },

        /** Stop editing a saved setup without updating it — its sealed conversation stays with it. */
        async later({ state }) {
            if (!editingId(state)) return { reason: 'nothing_to_commit' }
            return { result: {}, after: null }
        },
    }
}

export const mentorActions = makeMentorActions()

/**
 * A direct edit (K3): the user changed the draft by hand. Re-judged by the same verdict a turn and the validate
 * route use, so the gate and readiness the surface draws from stay true. `{ state }` or `{ reason }`.
 * Edits: `{ draft, accounts? }` — the whole draft as edited.
 *
 * THE BUILD LEDGER IS THE SERVER'S. It rides on the draft (`draft.build`: the stages confirmed, the size held —
 * docs/design/mentor-flow-intent.md), and a hand edit is of the plan's fields, never of where the build stands. The
 * client's copy is dropped and the session's kept — otherwise an edit could mark stages confirmed that Mentor never
 * walked (phase 8a bug hunt #1).
 *
 * `{ draft, fresh: true }` — a NEW plan, not an edit of this one: a setup someone shared, opened in my Mentor (phase
 * 8b). Mentor's table is cleared first — the other names, the coverage, the gate — and so are its markers
 * (`dropMarkers`): kept, an `editing` marker would make the next Update write someone else's plan onto the setup I
 * was editing. The client asks before replacing work Mentor holds.
 */
export function mentorApplyEdit(state, edit = {}) {
    const fresh = edit.fresh === true
    if (!state && !fresh) return { reason: 'nothing_to_edit' }
    if (!('draft' in edit)) return { reason: 'invalid_edit' }
    if (!edit.draft || typeof edit.draft !== 'object' || Array.isArray(edit.draft)) return { reason: 'invalid_setup' }
    const base = fresh ? { ...emptyMentorState(), drafts: {}, view: { gate: null, readiness: null, setups: null } } : state
    const { build: _theirs, ...fields } = edit.draft   // eslint-disable-line no-unused-vars -- dropped on purpose
    const draft = base.draft?.build ? { ...fields, build: base.draft.build } : fields
    const verdict = draftVerdict(draft, parseIdeaAccounts(edit.accounts).length > 0)
    if (!verdict) return { reason: 'invalid_setup' }
    return {
        state: {
            ...base,
            draft,
            active_asset: draft.asset || base.active_asset || '',
            view: { ...(base.view ?? {}), readiness: verdict.readiness, ...(verdict.gate ? { gate: verdict.gate } : {}) },
        },
        ...(fresh ? { dropMarkers: true } : {}),
    }
}
