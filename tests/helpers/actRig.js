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
 * `midChain` (the default): the session runs a chain another desk started, so a commit does NOT end it — a desk's tests
 * are about what it saves and what it leaves on its table, which only stands while the session goes on. Since a commit
 * ends the session (2026-10-18), the ending itself is tested on its own, with `midChain: false` (commitEndsSession).
 * @param {{ agent: string, desk: object, state?: object|null, scope?: string, sessions?: object, sealing?: object,
 *           midChain?: boolean }} p
 */
export function makeActRig({ agent, desk, state = null, scope = 'main', sessions: given = null, sealing = null, midChain = true }) {
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
            if (midChain) await sessions.setChain({ sessionId: s.sessionId, userId: String(user._id), chain: { id: 'rig_chain', status: 'running', origin: 'rig' } })
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

/**
 * A result without what the PIPE adds — the revision, and the next session a commit opened (act.endAfterCommit, its
 * own tests in commitEndsSession.test.js) — for asserting a desk's result shape.
 */
export const shapeOf = (out) => {
    if (!out || out.reason) return out
    const { rev: _rev, ...rest } = out   // eslint-disable-line no-unused-vars -- dropped on purpose
    if (rest.result && 'nextSessionId' in rest.result) {
        const { nextSessionId: _next, ...result } = rest.result   // eslint-disable-line no-unused-vars -- dropped on purpose
        return { ...rest, result }
    }
    return rest
}
