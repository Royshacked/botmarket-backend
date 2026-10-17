// Mentor's commits and direct edits, run against the SESSION (unified-chat plan phase 8, K2/K3).
//
// The draft is read from Mentor's agentState — never from the client — and handed to the SAME service the setup
// routes use (setupService.generateSetup / generateSetups / patchSetup). What each press means is Mentor's
// judgement and lives here; the route and the lock are shared (services/desks/act.js).
//
// An action answers `{ reason }` (refused) or `{ result, seal?, after? }`:
//   result  what the client shows (the saved setup, the batch outcome)
//   seal    the entities this commit produced — Mentor's turns move onto them (seal.js), in-line, under the lock
//   after   Mentor's state once the commit is done (undefined: leave it; null: clear it). After a Generate the
//           state is `{ generated }` — the setup exists but nothing watches it until it is armed, and that
//           distinction is the whole reason the surface stops on "Arm it / Leave it waiting".

import { setupService as defaultSetups } from '../../../api/setups/setups.service.js'
import { resolveCardsFor as defaultResolveCards } from '../../../api/chat/chat.service.js'
import { parseIdeaAccounts } from '../../../api/_shared/parse.util.js'
import { draftVerdict } from '../../setupVerdict.js'
import { emptyMentorState } from '../../agents/mentor.agent.service.js'

const MAX_BATCH = 10   // the ledger's own cap on names (mentorBuild.util MAX_NAMES)

const commitArgs = (args = {}) => ({
    accounts:      parseIdeaAccounts(args.accounts),
    mainAccountId: args.mainAccountId != null ? String(args.mainAccountId) : null,
})
const generatedOf = (doc) => ({ id: doc.id, asset: doc.asset ?? null, status: doc.status ?? null })
const editingId   = (state) => (state?.editing?.kind === 'setup' ? String(state.editing.entityId) : null)

export function makeMentorActions({ setups = defaultSetups, resolveCards = defaultResolveCards } = {}) {
    return {
        /** Save the draft — a new setup, or the one being edited (an update). */
        async generate({ user, state, args }) {
            const draft = state?.draft
            if (!draft) return { reason: 'nothing_to_commit' }
            const { accounts, mainAccountId } = commitArgs(args)
            if (!accounts.length) return { reason: 'no_venue' }
            const updateId = editingId(state)
            const out = await setups.generateSetup(draft, {
                userId: user._id, accounts, mainAccountId, updateId,
                chatState: { draft, coverage: state.coverage ?? [] },
            })
            if (!out.ok) return { reason: out.reason }
            // After the write: an update satisfies the cards asking for it (a redraw, an invalidation).
            if (updateId) await resolveCards({ kind: 'setup', id: updateId }, { outcome: 'completed' })
            return {
                result: { setup: out.doc },
                seal:   { kind: 'setup', entityIds: [out.doc.id], name: out.doc.asset ? `${out.doc.asset} setup` : null, onlyIfEditing: !!updateId },
                // An update is done; a new setup waits on Arm.
                after:  updateId ? null : { ...emptyMentorState(), generated: generatedOf(out.doc) },
            }
        },

        /** Save every plan of a multi-name build. Partial success is the contract: refused plans stay on the table. */
        async generateAll({ user, state, args }) {
            const byAsset = { ...(state?.drafts ?? {}), ...(state?.draft?.asset ? { [state.draft.asset]: state.draft } : {}) }
            const all = Object.values(byAsset).slice(0, MAX_BATCH)
            if (all.length < 2) return { reason: 'nothing_to_commit' }
            const { accounts, mainAccountId } = commitArgs(args)
            if (!accounts.length) return { reason: 'no_venue' }
            const { saved, failed } = await setups.generateSetups(all, {
                userId: user._id, accounts, mainAccountId, chatState: { draft: state.draft ?? null, coverage: state.coverage ?? [] },
            })
            if (!saved.length) return { reason: failed[0]?.reason ?? 'nothing_saved', extra: { failed } }
            const refused = Object.fromEntries(failed.filter(f => f.asset && byAsset[f.asset]).map(f => [f.asset, byAsset[f.asset]]))
            const left    = Object.values(refused)
            return {
                result: { saved, failed },
                seal:   { kind: 'setup', entityIds: saved.map(d => d.id) },
                after:  {
                    ...emptyMentorState(),
                    // What was refused stays, by asset, so the next turn can fix it.
                    draft:     left[0] ?? null,
                    active_asset: left[0]?.asset ?? '',
                    drafts:    left.length > 1 ? refused : {},
                    generated: generatedOf(saved[saved.length - 1]),
                },
            }
        },

        /** Arm the setup just generated — the gate re-runs in the service. */
        async arm({ user, state }) {
            const id = state?.generated?.id
            if (!id) return { reason: 'nothing_to_commit' }
            const out = await setups.patchSetup(id, { status: 'looking' }, user._id)
            if (!out.ok) return { reason: out.reason }
            await resolveCards({ kind: 'setup', id }, { outcome: 'completed' })
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
 */
export function mentorApplyEdit(state, edit = {}) {
    if (!state) return { reason: 'nothing_to_edit' }
    if (!('draft' in edit)) return { reason: 'invalid_edit' }
    if (!edit.draft || typeof edit.draft !== 'object' || Array.isArray(edit.draft)) return { reason: 'invalid_setup' }
    const { build: _theirs, ...fields } = edit.draft   // eslint-disable-line no-unused-vars -- dropped on purpose
    const draft = state.draft?.build ? { ...fields, build: state.draft.build } : fields
    const verdict = draftVerdict(draft, parseIdeaAccounts(edit.accounts).length > 0)
    if (!verdict) return { reason: 'invalid_setup' }
    return {
        state: {
            ...state,
            draft,
            active_asset: draft.asset || state.active_asset || '',
            view: { ...(state.view ?? {}), readiness: verdict.readiness, ...(verdict.gate ? { gate: verdict.gate } : {}) },
        },
    }
}
