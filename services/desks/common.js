// The argument bag every desk's agent takes — ONE builder for both callers of a desk: the HTTP
// desk stream (api/_shared/deskStream.util.js — the path the frontend uses today) and the session turn
// (services/desks/sessionTurn.js, unified-chat plan phase 4).
//
// A desk spreads it into its agent call and adds only what is its own (its state, its per-turn input,
// its extra events through `emit`).

import { sseAgentCallbacks } from '../../api/_shared/sse.util.js'

/**
 * @param {{ messages: object[], model?: string, user: { _id: string }, audience?: string|null,
 *           signal?: AbortSignal, emit: (event: string, data: object) => void }} p
 */
export function deskCommon({ messages, model, user, audience = null, signal, emit }) {
    return {
        messages,
        model,
        userId:   user._id,
        audience,
        signal,
        ...sseAgentCallbacks(emit),
    }
}
