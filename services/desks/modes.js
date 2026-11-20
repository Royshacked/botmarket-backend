// THE MODE the chat is in (docs/design/modes-and-builders.md M3/M4, step 3 — Roy, 2026-11-20): General (Axl) or one of
// the BUILDERS — the trader, the portfolio manager, the analyst. The picker on the prompt box shows it and switches it;
// Axl switches it himself when the prompt asks to build (his route to a builder moves the floor there).
//
// The mode is DERIVED from the floor, never stored beside it — a second copy would drift: a builder on the floor is that
// builder's mode, anyone else is General. Switching moves the floor, under the session lock, so it never races a turn.
// A builder left with work on its table keeps it (agentState), parked: picking it again picks the work up.
//
// Built as a factory so the tests run it on memDb.

import { sessionService } from '../session.service.js'
import { withSessionLock } from './turnLock.js'
import { canSpeak } from './sessionTurn.js'

/** The modes the picker offers → the agent that holds the floor in each. */
export const MODES = Object.freeze({ general: 'axl', mentor: 'mentor', portfolio: 'portfolio', analyst: 'analyst' })

/** The mode a floor means. Pure; exported for tests and the client's twin (mode.utils). */
export function modeOf(floor) {
    return floor && floor !== 'axl' && MODES[floor] === floor ? floor : 'general'
}

export function makeModes({ sessions = sessionService, lock = withSessionLock } = {}) {
    /**
     * Switch the session's mode. Queued behind a running turn (the lock), so it lands after it — the reply to a 202.
     * @returns {Promise<{ mode: string, floor: string } | { reason: string }>} `done` resolves when it is applied
     */
    async function setMode({ user, sessionId, mode }) {
        const agent = MODES[mode]
        if (!agent) return { reason: 'invalid_mode' }
        const session = await sessions.get({ sessionId, userId: user._id })
        if (!session || session.status !== 'active') return { reason: 'not_found' }
        if (!canSpeak(agent, session, user)) return { reason: 'forbidden' }
        const done = lock(sessionId, async () => {
            const r = await sessions.setFloor({ sessionId, userId: user._id, agent })
            return r.reason ? r : { mode, floor: agent }
        })
        return { mode, floor: agent, done }
    }

    return { setMode }
}

export const modes = makeModes()
