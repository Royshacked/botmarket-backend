// One rig for the desk-action tests (unified-chat plan phase 8a): an in-memory session store, the real act pipe
// (services/desks/act.js) over ONE desk, a recording seal that clears the agent's state as the real one does, and a
// pass-through lock. `press` / `edit` name the agent's CURRENT revision unless told otherwise — the client always
// sends the revision it rendered, and a stale one is its own test.

import { memDb } from './memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeAct } from '../../services/desks/act.js'

export const ADMIN  = Object.freeze({ _id: 'u1', role: 'admin' })
export const TRADER = Object.freeze({ _id: 'u1', role: 'trader' })

/**
 * @param {{ agent: string, desk: object, state?: object|null, scope?: string, sessions?: object, sealing?: object }} p
 */
export function makeActRig({ agent, desk, state = null, scope = 'main', sessions: given = null, sealing = null }) {
    const { db } = memDb()
    const sessions = given ?? makeSessionService({ getDb: async () => db })
    const seals = [], asides = []
    const seal = sealing ?? {
        sealFromSession: async (a) => {
            seals.push(a)
            await sessions.setAgentState({ sessionId: a.sessionId, userId: a.userId, agent: a.agent, state: null })
            return { sealed: 1 }
        },
        putAside: async (a) => { asides.push(a); return { through: 0 } },
    }
    const pipe = makeAct({ sessions, desks: { [agent]: desk }, sealing: seal, lock: (_id, fn) => fn() })

    return {
        sessions, seals, asides, ...pipe,
        async start(user = ADMIN) {
            const s = await sessions.getActive({ userId: String(user._id), scope })
            if (state) await sessions.setAgentState({ sessionId: s.sessionId, userId: String(user._id), agent, state })
            const read  = () => sessions.get({ sessionId: s.sessionId, userId: String(user._id) })
            const rev   = async () => (await read())?.agentRev?.[agent] ?? 0
            return {
                s,
                rev,
                stateOf: async () => (await read())?.agentState?.[agent] ?? null,
                setState: (next) => sessions.setAgentState({ sessionId: s.sessionId, userId: String(user._id), agent, state: next }),
                press: async (action, args = {}, { rev: at } = {}) => pipe.act({ user, sessionId: s.sessionId, agent, action, args, rev: at ?? await rev() }),
                edit:  async (edit, { rev: at } = {}) => pipe.editState({ user, sessionId: s.sessionId, agent, edit, rev: at ?? await rev() }),
            }
        },
    }
}

/** A result without the revision the pipe answers with — for asserting a desk's result shape. */
export const shapeOf = (out) => {
    if (!out || out.reason) return out
    const { rev: _rev, ...rest } = out   // eslint-disable-line no-unused-vars -- dropped on purpose
    return rest
}
