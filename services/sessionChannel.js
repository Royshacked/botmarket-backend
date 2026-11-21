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

// sessionId → the turn streaming in it right now: { turnId, agent, userId, text, startedAt }
// Keyed by LANE (step 5a): Axl's turn and a desk's can stream at once — `${sessionId}|axl` / `${sessionId}|desk`.
const running = new Map()
const laneOf = (sessionId, agent) => `${sessionId}|${agent === 'axl' ? 'axl' : 'desk'}`

/**
 * The emitter for one session turn.
 * @returns {{ emit: (type: string, data: object) => void, status: (status: string, extra?: object) => void, end: () => void }}
 */
export function turnEmitter({ userId, sessionId, turnId, agent, send = wsEmit }) {
    const uid  = String(userId)
    const live = { turnId, agent, userId: uid, text: '', startedAt: Date.now() }
    const lane = laneOf(sessionId, agent)
    running.set(lane, live)
    return {
        // `as`: a SUBAGENT streaming inside this turn (desks/subagent.js) — its frames name the role that writes them, so
        // the chat draws its words under that role. The replay keeps only the turn's own agent's text.
        emit(type, data, as = agent) {
            if (type === 'token' && typeof data?.text === 'string' && as === agent) live.text += data.text
            send(uid, 'session_delta', { sessionId, turnId, agent: as, type, data })
        },
        status(status, extra = {}) {
            send(uid, 'session_turn', { sessionId, turnId, agent, status, ...extra })
        },
        end() {
            if (running.get(lane) === live) running.delete(lane)
        },
    }
}

/**
 * A turn's status frame WITHOUT taking its lane — a turn still waiting behind another (`queued`) must not replace the one
 * that runs, which a replay reads from `running`.
 */
export function turnNotice({ userId, sessionId, turnId, agent, status, extra = {}, send = wsEmit }) {
    send(String(userId), 'session_turn', { sessionId, turnId, agent, status, ...extra })
}

/** The turn streaming in a session's lane right now (Axl's, else a desk's), or null. Exported for tests. */
export function runningTurn(sessionId, lane = null) {
    if (lane) return running.get(`${sessionId}|${lane}`) ?? null
    return running.get(`${sessionId}|axl`) ?? running.get(`${sessionId}|desk`) ?? null
}

/** Answer one `session_sync` frame. */
export async function replay({ userId, data, reply }, store = sessionService) {
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : null
    if (!sessionId) return
    const session = await store.get({ sessionId, userId })
    if (!session) return reply('session_replay', { sessionId, error: 'not_found' })
    const messages = await store.allMessagesSince({ sessionId, userId, afterSeq: Number(data?.afterSeq) || 0 })
    // The turn the user is watching — the floor's lane — and the one running behind it in the other lane (step 5a).
    const own = (t) => (t && t.userId === String(userId) ? { turnId: t.turnId, agent: t.agent, text: t.text } : null)
    const axl = own(running.get(`${sessionId}|axl`)), desk = own(running.get(`${sessionId}|desk`))
    const watching = (session.floor ?? 'axl') === 'axl' ? axl ?? desk : desk ?? axl
    reply('session_replay', {
        sessionId,
        status:   session.status,
        floor:    session.floor,
        // What the user missed besides rows: the chain a decision card waits on, and each desk's state.
        chain:      session.chain ? { id: session.chain.id, status: session.chain.status, awaiting: session.chain.awaiting ?? null } : null,
        agentState: session.agentState ?? {},
        // The reads the chat is waiting on (setWaiting) — the status line a reload must draw again.
        waiting:    session.waiting ?? {},
        // The revision of each — what a press or a hand edit names (plan phase 8a CR D2).
        agentRev:   session.agentRev ?? {},
        messages: messages ?? [],
        running:    watching,
        background: watching === axl ? desk : null,
    })
}

/** Register the client frame this channel answers. Called once at startup (server.js). */
export function registerSessionChannel() {
    onClientEvent('session_sync', (frame) => replay(frame))
}
