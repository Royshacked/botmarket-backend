// The unified chat's live channel — a running turn's stream, and the replay that catches a screen up
// (plan phase 5a). It rides the EXISTING WebSocket (api/chat/chatWs.js, G1); chatWs owns the socket,
// sessionEvents pushes what the store changes, and this module adds the two things a turn needs:
//
//   turnEmitter  the `emit` a session turn streams through → `session_delta` frames (tokens, status,
//                reasoning, charts, a desk's own events) and `session_turn` (started / done / stopped /
//                error); it keeps the turn's text so far, so a screen that connects mid-turn gets it.
//   replay       the answer to a client's `session_sync { sessionId, afterSeq }` — sent on every (re)connect:
//                every row after that seq, the running turn's text so far (once — the live deltas carry on
//                from there), the floor. To THAT socket only.
//
// In-process, like the socket registry it rides (docs/architecture/single-instance.md).

import { emit as wsEmit, onClientEvent } from '../api/chat/chatWs.js'
import { sessionService } from './session.service.js'
import { hydrateCards } from './sessionCards.js'

// sessionId → the turn streaming in it right now: { turnId, agent, userId, text, startedAt }
const running = new Map()

/**
 * The emitter for one session turn.
 * @returns {{ emit: (type: string, data: object) => void, status: (status: string, extra?: object) => void, end: () => void }}
 */
export function turnEmitter({ userId, sessionId, turnId, agent, send = wsEmit }) {
    const uid  = String(userId)
    const live = { turnId, agent, userId: uid, text: '', startedAt: Date.now() }
    running.set(sessionId, live)
    return {
        emit(type, data) {
            if (type === 'token' && typeof data?.text === 'string') live.text += data.text
            send(uid, 'session_delta', { sessionId, turnId, agent, type, data })
        },
        status(status, extra = {}) {
            send(uid, 'session_turn', { sessionId, turnId, agent, status, ...extra })
        },
        end() {
            if (running.get(sessionId) === live) running.delete(sessionId)
        },
    }
}

/** The turn streaming in a session right now, or null. Exported for tests and the turn lock. */
export function runningTurn(sessionId) {
    return running.get(sessionId) ?? null
}

/** Answer one `session_sync` frame. */
export async function replay({ userId, data, reply }, store = sessionService, hydrate = hydrateCards) {
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : null
    if (!sessionId) return
    const session = await store.get({ sessionId, userId })
    if (!session) return reply('session_replay', { sessionId, error: 'not_found' })
    const messages = await store.allMessagesSince({ sessionId, userId, afterSeq: Number(data?.afterSeq) || 0 })
    const live = running.get(sessionId)
    reply('session_replay', {
        sessionId,
        status:   session.status,
        floor:    session.floor,
        messages: await hydrate(messages ?? []),
        running:  live && live.userId === String(userId) ? { turnId: live.turnId, agent: live.agent, text: live.text } : null,
    })
}

/** Register the client frame this channel answers. Called once at startup (server.js). */
export function registerSessionChannel() {
    onClientEvent('session_sync', (frame) => replay(frame))
}
