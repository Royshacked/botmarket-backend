// A desk's commits and direct edits, against the session (unified-chat plan phase 8, K2/K3).
//
//   act        POST /api/sessions/:id/act { agent, action, args }   — Generate, Arm, Update, Later…
//   editState  PATCH /api/sessions/:id/state { agent, edit }        — the user changed the work by hand
//
// SHARE THE PIPE, NOT THE JUDGEMENT (CLAUDE.md): this module is the pipe — the session read, the speaker rule,
// the lock, the seal, the state write. What a press MEANS is the desk's own (`actions` / `applyEdit` on its
// definition, services/desks/actions/*). The draft a commit saves is read from the agent's state here, never
// taken from the client, so what is saved is what the user and the desk built.
//
// Both run under the session lock, like a turn: a commit reads the state, writes a document, seals the turns
// and sets the state — a turn interleaving would either lose its state to the seal or rewrite state for
// sealed work.

import { sessionService } from '../session.service.js'
import { DESK_DEFS } from './index.js'
import { canSpeak } from './sessionTurn.js'
import { sealing as defaultSealing } from './seal.js'
import { withSessionLock } from './turnLock.js'
import { agentForKind } from './registry.js'
import { logger } from '../logger.service.js'

const LOG = '[desk:act]'
const MAX_NAME = /^[a-zA-Z]{1,40}$/

export function makeAct({ sessions = sessionService, desks = DESK_DEFS, sealing = defaultSealing, lock = withSessionLock } = {}) {

    /** The session, the desk and the speaker rule every press passes first. */
    async function _open({ user, sessionId, agent }) {
        const desk = desks[agent]
        if (!desk) return { reason: 'invalid_agent' }
        const session = await sessions.get({ sessionId, userId: user._id })
        if (!session || session.status !== 'active') return { reason: 'not_found' }
        if (!canSpeak(agent, session, user)) return { reason: 'forbidden' }
        return { desk, session }
    }

    /** @returns {Promise<{ reason: string, extra?: object } | { result: object }>} */
    function act({ user, sessionId, agent, action, args = {} }) {
        if (typeof action !== 'string' || !MAX_NAME.test(action)) return Promise.resolve({ reason: 'no_such_action' })
        return lock(sessionId, async () => {
            const opened = await _open({ user, sessionId, agent })
            if (opened.reason) return opened
            // OWN keys only: `constructor` / `valueOf` resolve on any object literal (phase 8a bug hunt #2).
            const actions = opened.desk.actions
            const handler = actions && Object.hasOwn(actions, action) ? actions[action] : null
            if (typeof handler !== 'function') return { reason: 'no_such_action' }

            const state = opened.session.agentState?.[agent] ?? null
            const out = await handler({ user, state, args: args && typeof args === 'object' ? args : {}, sessionId })
            if (!out || out.reason) {
                // A refusal can still narrow what is on the table (Atlas: the changes refused for AVOID, marked to ask).
                if (out?.after !== undefined) await sessions.setAgentState({ sessionId, userId: user._id, agent, state: out.after })
                return { reason: out?.reason ?? 'action_failed', ...(out?.extra ? { extra: out.extra } : {}) }
            }

            // The turns that built it move onto what was saved — in-line, so the client's next read already has the
            // sealed line. A seal that fails never undoes the save (the document is the user's).
            if (out.seal) {
                const sealAgent = agentForKind(out.seal.kind) ?? agent
                await sealing.sealFromSession({ userId: user._id, sessionId, agent: sealAgent, ...out.seal })
                    .catch(err => logger.warn(LOG, 'seal after commit failed (the entity is saved)', err.message))
            }
            // AFTER the seal, which clears the state itself — the desk's `after` is what stands once it has. The entity
            // exists by now, so a failed state write is logged and SAID (`stateWritten: false`), never answered as a
            // failure: a 500 here invites the retry that saves the same work twice (phase 8a bug hunt #4).
            if (out.after !== undefined) {
                try {
                    await sessions.setAgentState({ sessionId, userId: user._id, agent, state: out.after })
                } catch (err) {
                    logger.error(LOG, 'state write after a commit failed (the entity is saved)', { agent, action, error: err.message })
                    return { result: out.result ?? {}, stateWritten: false }
                }
            }
            return { result: out.result ?? {} }
        })
    }

    /** @returns {Promise<{ reason: string } | { ok: true }>} */
    function editState({ user, sessionId, agent, edit }) {
        return lock(sessionId, async () => {
            const opened = await _open({ user, sessionId, agent })
            if (opened.reason) return opened
            if (typeof opened.desk.applyEdit !== 'function') return { reason: 'not_editable' }
            const state = opened.session.agentState?.[agent] ?? null
            const out = await opened.desk.applyEdit(state, edit && typeof edit === 'object' ? edit : {})
            if (!out || out.reason) return { reason: out?.reason ?? 'invalid_edit' }
            // What sessionTurn keeps across a fold, kept across an edit too: what it is editing, which chain it works for.
            const kept = { ...out.state, ...(state?.editing ? { editing: state.editing } : {}), ...(state?.chainId ? { chainId: state.chainId } : {}) }
            await sessions.setAgentState({ sessionId, userId: user._id, agent, state: kept })
            return { ok: true }
        })
    }

    return { act, editState }
}

export const deskAct = makeAct()
