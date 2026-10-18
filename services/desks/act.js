// A desk's commits and direct edits, against the session (unified-chat plan phase 8, K2/K3).
//
//   act        POST /api/sessions/:id/act { agent, action, args, rev }   — Generate, Arm, Update, Later…
//   editState  PATCH /api/sessions/:id/state { agent, edit, rev }        — the user changed the work by hand
//
// SHARE THE PIPE, NOT THE JUDGEMENT (CLAUDE.md): this module is the pipe — the session read, the speaker rule,
// the revision check, the lock, the seal, the state write. What a press MEANS is the desk's own (`actions` /
// `applyEdit` on its definition, services/desks/actions/* — the action contract is in mentor.actions.js). The draft a
// commit saves is read from the agent's state here, never taken from the client, so what is saved is what the user
// and the desk built.
//
// Both run under the session lock, like a turn: a commit reads the state, writes a document, seals the turns
// and sets the state — a turn interleaving would either lose its state to the seal or rewrite state for
// sealed work.
//
// THE REVISION (`rev`, phase 8a CR D2). Every state write bumps the agent's revision (session.service
// setAgentState), and a press names the revision the user was LOOKING AT. A press queued behind a turn would
// otherwise act on what the turn left — Generate pressed on draft v1 saving v2, a hand edit of v1 overwriting v2.
// A stale press is refused (`stale_state`, with the current revision) and the client redraws first.

import { sessionService } from '../session.service.js'
import { DESK_DEFS, hasWork } from './index.js'
import { endedChain } from '../chain/rules.js'
import { canSpeak } from './sessionTurn.js'
import { sealing as defaultSealing, sealLabel } from './seal.js'
import { withSessionLock } from './turnLock.js'
import { agentForKind } from './registry.js'
import { keepMarkers } from './markers.js'
import { logger } from '../logger.service.js'

const LOG = '[desk:act]'
const ACTION_NAME = /^[a-zA-Z]{1,40}$/
// Where a saved thing lives — the next session's first line says so (endAfterCommit).
const WHERE = { setup: ' to your Setups', portfolio: ' to your Portfolios', scan: ' to your Scans', coverage: ' to Coverage', industry_view: ' to the house views' }

export function makeAct({ sessions = sessionService, desks = DESK_DEFS, sealing = defaultSealing, lock = withSessionLock } = {}) {

    /** The session, the desk, the speaker rule and the revision every press passes first. */
    async function _open({ user, sessionId, agent, rev }) {
        const desk = desks[agent]
        if (!desk) return { reason: 'invalid_agent' }
        const session = await sessions.get({ sessionId, userId: user._id })
        if (!session || session.status !== 'active') return { reason: 'not_found' }
        if (!canSpeak(agent, session, user)) return { reason: 'forbidden' }
        const current = session.agentRev?.[agent] ?? 0
        if (!Number.isInteger(rev) || rev !== current) return { reason: 'stale_state', extra: { rev: current } }
        return { desk, session, state: session.agentState?.[agent] ?? null }
    }

    /** The agent's revision once a press has written — what the client's next press names. */
    async function _revNow({ user, sessionId, agent }) {
        const session = await sessions.get({ sessionId, userId: user._id }).catch(() => null)
        return session?.agentRev?.[agent] ?? null
    }

    /**
     * A COMMIT ENDS THE SESSION (Roy, 2026-10-18). Saving the work — Generate, Update, Initiate, Accept, Publish — is the
     * end of that piece of work: the session is archived (History keeps it, with its sealed line) and a fresh one opens
     * with Axl, its first line saying what was saved, so the user sees they are back at the start. Every open screen
     * follows (startNew's `archived → next` frame).
     *
     * Not mid-chain: while a chain runs, a save by a desk the chain went THROUGH (Argus's list, Prometheus's coverage on
     * Atlas's errand) keeps the session — the chain ends it, when the desk that started it commits (`endsSession`).
     * The seal before it leaves the timeline as it was (`keepTimeline`): nothing moves in a session about to close.
     * @returns {Promise<string|null>} the new session's id, or null when the session goes on
     */
    async function endAfterCommit({ user, session, agent, seal }) {
        const next = await sessions.startNew({ userId: user._id, scope: session.scope ?? 'main', force: true })
        if (!next?.sessionId || next.sessionId === session.sessionId) return null
        const ids = (seal.entityIds ?? []).filter(Boolean).map(String)
        await sessions.append({ sessionId: next.sessionId, userId: user._id, message: {
            agent: 'axl', role: 'assistant', kind: 'sealed',
            content: `✓ ${sealLabel({ agent, kind: seal.kind, ids, name: seal.name ?? null })} — saved${WHERE[seal.kind] ?? ''}. You're back with Axl.`,
            ref: { kind: seal.kind, ids, ended: true, from: session.sessionId },
        } })
        return next.sessionId
    }

    /** Whether a commit by `agent` ends this session — always, except a save by a desk a running chain went THROUGH. */
    function endsSession(session, agent) {
        const chain = session.chain
        return !(chain && chain.status !== 'done' && chain.origin && chain.origin !== agent)
    }

    /** @returns {Promise<{ reason: string, extra?: object } | { result: object, rev: number|null, stateWritten?: false }>} */
    function act({ user, sessionId, agent, action, args = {}, rev }) {
        if (typeof action !== 'string' || !ACTION_NAME.test(action)) return Promise.resolve({ reason: 'no_such_action' })
        return lock(sessionId, async () => {
            const opened = await _open({ user, sessionId, agent, rev })
            if (opened.reason) return opened
            // OWN keys only: `constructor` / `valueOf` resolve on any object literal (phase 8a bug hunt #2).
            const actions = opened.desk.actions
            const handler = actions && Object.hasOwn(actions, action) ? actions[action] : null
            // DISCARD is the pipe's, not a desk's (phase 8e — the old panels' Clear): UNSAVED work is thrown away and its
            // turns set aside, so they never seal onto what the desk builds next. Nothing is saved, so nothing is judged.
            //   • a saved item being edited is Later's, not this (its turns belong to it) — refused;
            //   • a table holding only settings (a lens, a mandate) has nothing to discard;
            //   • the desk's settings stay (`cleanTable`, when the desk names what survives — Argus's lens);
            //   • a chain the work belonged to ends with it, or it would bring the discarded work back (phase 8e CR).
            if (action === 'discard' && typeof handler !== 'function') {
                const state = opened.state
                if (state?.editing) return { reason: 'editing_use_later' }
                if (!hasWork(agent, state)) return { reason: 'nothing_to_commit' }
                const chain = opened.session.chain
                if (state.chainId && chain?.id === state.chainId && chain.status !== 'done') {
                    await sessions.setChain({ sessionId, userId: user._id, chain: endedChain(chain) })
                }
                const kept = typeof opened.desk.cleanTable === 'function' ? opened.desk.cleanTable(state) : null
                await sessions.setAgentState({ sessionId, userId: user._id, agent, state: kept })
                await sealing.putAside({ userId: user._id, sessionId, agent })
                return { result: {}, rev: await _revNow({ user, sessionId, agent }) }
            }
            if (typeof handler !== 'function') return { reason: 'no_such_action' }

            const out = await handler({ user, state: opened.state, args: args && typeof args === 'object' ? args : {} })
            if (!out || out.reason) {
                // A refusal can still narrow what is on the table (Atlas: the changes refused for AVOID, marked to ask).
                if (out?.after !== undefined) await sessions.setAgentState({ sessionId, userId: user._id, agent, state: out.after })
                return { reason: out?.reason ?? 'action_failed', ...(out?.extra ? { extra: out.extra } : {}) }
            }

            // The turns that built it move onto what was saved — in-line, so the client's next read already has the
            // sealed line. A seal that fails never undoes the save (the document is the user's).
            const sealAgent = out.seal ? agentForKind(out.seal.kind) ?? agent : null
            // A commit that ENDS the session leaves its timeline as it was — no turns moved out, no line, no state write:
            // the session closes a moment later, and anything changed in it now only flashes on screen first.
            const ending = !!out.seal && endsSession(opened.session, sealAgent)
            if (out.seal) {
                await sealing.sealFromSession({ userId: user._id, sessionId, agent: sealAgent, ...out.seal, ...(ending ? { keepTimeline: true } : {}) })
                    .catch(err => logger.warn(LOG, 'seal after commit failed (the entity is saved)', err.message))
            }
            // AFTER the seal, which clears the state itself — the desk's `after` is what stands once it has. The entity
            // exists by now, so a failed state write is logged and SAID (`stateWritten: false`), never answered as a
            // failure: a 500 here invites the retry that saves the same work twice (phase 8a bug hunt #4).
            if (out.after !== undefined && !ending) {
                try {
                    await sessions.setAgentState({ sessionId, userId: user._id, agent, state: out.after })
                } catch (err) {
                    logger.error(LOG, 'state write after a commit failed (the entity is saved)', { agent, action, error: err.message })
                    return { result: out.result ?? {}, rev: null, stateWritten: false }
                }
            }
            const revNow = await _revNow({ user, sessionId, agent })
            // Last: the save, the seal and the state all landed — THEN the session ends (never a failure: it is saved).
            const next = ending
                ? await endAfterCommit({ user, session: opened.session, agent: sealAgent, seal: out.seal })
                    .catch(err => { logger.warn(LOG, 'ending the session after a commit failed (the entity is saved)', err.message); return null })
                : null
            return { result: { ...(out.result ?? {}), ...(next ? { nextSessionId: next } : {}) }, rev: revNow }
        })
    }

    /** @returns {Promise<{ reason: string, extra?: object } | { ok: true, rev: number|null }>} */
    function editState({ user, sessionId, agent, edit, rev }) {
        return lock(sessionId, async () => {
            const opened = await _open({ user, sessionId, agent, rev })
            if (opened.reason) return opened
            if (typeof opened.desk.applyEdit !== 'function') return { reason: 'not_editable' }
            // The user rides along for an edit that writes something of theirs (Atlas staging an adoption).
            const out = await opened.desk.applyEdit(opened.state, edit && typeof edit === 'object' ? edit : {}, { user })
            if (!out || out.reason) return { reason: out?.reason ?? 'invalid_edit' }
            // The markers survive a hand edit — unless the edit replaces the work outright (`dropMarkers`: a new plan
            // is not an edit of the one being edited). Then the turns about the old work are set aside too (phase 8e),
            // AFTER the write they belong to: a write that failed leaves the old work on the table with its turns.
            const next = out.dropMarkers === true ? out.state : keepMarkers(out.state, opened.state)
            const written = await sessions.setAgentState({ sessionId, userId: user._id, agent, state: next })
            if (out.dropMarkers === true) await sealing.putAside({ userId: user._id, sessionId, agent })
            return { ok: true, rev: written?.rev ?? null }
        })
    }

    return { act, editState }
}

export const deskAct = makeAct()
