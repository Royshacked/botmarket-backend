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
import { DESK_DEFS } from './index.js'
import { canSpeak } from './sessionTurn.js'
import { sealing as defaultSealing } from './seal.js'
import { withSessionLock } from './turnLock.js'
import { agentForKind } from './registry.js'
import { keepMarkers } from './markers.js'
import { logger } from '../logger.service.js'

const LOG = '[desk:act]'
const ACTION_NAME = /^[a-zA-Z]{1,40}$/

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

    /** @returns {Promise<{ reason: string, extra?: object } | { result: object, rev: number|null, stateWritten?: false }>} */
    function act({ user, sessionId, agent, action, args = {}, rev }) {
        if (typeof action !== 'string' || !ACTION_NAME.test(action)) return Promise.resolve({ reason: 'no_such_action' })
        return lock(sessionId, async () => {
            const opened = await _open({ user, sessionId, agent, rev })
            if (opened.reason) return opened
            // OWN keys only: `constructor` / `valueOf` resolve on any object literal (phase 8a bug hunt #2).
            const actions = opened.desk.actions
            const handler = actions && Object.hasOwn(actions, action) ? actions[action] : null
            if (typeof handler !== 'function') return { reason: 'no_such_action' }

            const out = await handler({ user, state: opened.state, args: args && typeof args === 'object' ? args : {} })
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
                    return { result: out.result ?? {}, rev: null, stateWritten: false }
                }
            }
            return { result: out.result ?? {}, rev: await _revNow({ user, sessionId, agent }) }
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
            // is not an edit of the one being edited).
            const next = out.dropMarkers === true ? out.state : keepMarkers(out.state, opened.state)
            const written = await sessions.setAgentState({ sessionId, userId: user._id, agent, state: next })
            return { ok: true, rev: written?.rev ?? null }
        })
    }

    return { act, editState }
}

export const deskAct = makeAct()
