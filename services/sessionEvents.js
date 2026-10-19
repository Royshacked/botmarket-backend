// What the unified chat pushes to a user's open screens — over the EXISTING WebSocket (api/chat/chatWs.js,
// plan phase 5 G1: one live transport per user, every tab and device).
//
// The session store calls these on every change it makes, so nothing can be stored without being sent:
//   session_message  a timeline row was appended
//   session_removed  rows left the timeline (a seal moved them onto an entity)
//   session_state    the floor moved, or an agent's working state changed (what the side pane draws)
// A running turn's stream (`session_delta`) and its lifecycle (`session_turn`) go through sessionChannel.
//
// Fire-and-forget: a user with no open socket simply misses the push, and the replay on reconnect
// (`session_sync`) is what catches them up — the store, not the socket, is the record.

import { emit } from '../api/chat/chatWs.js'

export const sessionEvents = {
    message: (userId, sessionId, message) => emit(userId, 'session_message', { sessionId, message }),
    removed: (userId, sessionId, seqs)    => emit(userId, 'session_removed', { sessionId, seqs }),
    state:   (userId, sessionId, patch)   => emit(userId, 'session_state',   { sessionId, ...patch }),
}

/** A store that pushes nothing — the default for tests and scripts that do not care. */
export const silentEvents = { message: () => {}, removed: () => {}, state: () => {} }
