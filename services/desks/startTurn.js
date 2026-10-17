// Accept a turn and run it in the background (unified-chat plan phase 5b, G2).
//
// The turn endpoint answers at once with the turn id; everything the turn produces — its streamed
// tokens, its reply, its state, where the floor goes — arrives on the session channel (the WebSocket).
//
//   who answers   the agent the user tapped, else an "@Brand" at the start of the text, else the floor
//   one at a time a per-session queue (turnLock): a turn posted while another runs waits its turn
//   stoppable     registered in turnRegistry under the client's turnId — the existing
//                 POST /api/turns/:turnId/stop stops it
//   after         `afterTurn` — the chain runner (phase 5c) decides what, if anything, runs next
//
// Built as a factory so the tests run it with stubs and no socket.

import { sessionService } from '../session.service.js'
import { parseMention } from '../session.util.js'
import { registerTurn } from '../../api/_shared/turnRegistry.js'
import { turnEmitter } from '../sessionChannel.js'
import { withSessionLock } from './turnLock.js'
import { sessionTurn as defaultSessionTurn, canSpeak } from './sessionTurn.js'
import { logger } from '../logger.service.js'

const LOG = '[startTurn]'

export function makeStartTurn({
    sessions    = sessionService,
    sessionTurn = defaultSessionTurn,
    emitterFor  = turnEmitter,
    afterTurn   = async () => {},
    lock        = withSessionLock,
} = {}) {

    /**
     * Run one turn (already accepted) under the session lock, streaming through the channel.
     * Exported through the factory so the chain runner can queue its own turns the same way.
     */
    function runQueued({ user, sessionId, agent, text, input = {}, turnId, origin = 'user' }) {
        return lock(sessionId, async () => {
            const ac      = new AbortController()
            const release = registerTurn(turnId, ac, user._id)
            const te      = emitterFor({ userId: user._id, sessionId, turnId, agent })
            te.status('started', { origin })
            try {
                const out = await sessionTurn({ user, sessionId, agent, text, input, origin, emit: te.emit, signal: ac.signal })
                if (out.reason)  te.status('refused', { reason: out.reason })
                else if (out.stopped) te.status('stopped')
                else te.status('done', { payload: out.payload })
                await afterTurn({ user, sessionId, agent, turnId, origin, out })
                return out
            } catch (err) {
                logger.warn(LOG, 'turn failed', { sessionId, agent, message: err.message })
                te.status('error', { message: 'The turn failed' })
                return { reason: 'error' }
            } finally {
                release()
                te.end()
            }
        })
    }

    /**
     * Accept a user's turn. Answers at once — `{ turnId, agent }` or `{ reason }`; the turn runs queued.
     * @param {{ user: object, sessionId: string, text: string, agent?: string, input?: object, turnId?: string }} p
     */
    async function startTurn({ user, sessionId, text, agent = null, input = {}, turnId = null }) {
        if (typeof text !== 'string' || !text.trim()) return { reason: 'empty' }
        const session = await sessions.get({ sessionId, userId: user._id })
        if (!session || session.status !== 'active') return { reason: 'not_found' }

        const mention = agent ? null : parseMention(text)
        const who     = agent ?? mention?.agent ?? session.floor ?? 'axl'
        if (!canSpeak(who, session, user)) return { reason: 'forbidden' }

        const id = typeof turnId === 'string' && turnId ? turnId : `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        runQueued({ user, sessionId, agent: who, text: mention ? mention.text || text : text, input, turnId: id })
            .catch(err => logger.warn(LOG, 'queued turn crashed', err.message))
        return { turnId: id, agent: who }
    }

    return { startTurn, runQueued }
}

export const { startTurn, runQueued } = makeStartTurn()
