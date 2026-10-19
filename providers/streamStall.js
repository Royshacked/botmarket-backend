// ── A model stream that stops sending is cut, not waited on ───────────────────────────────────────────────────
// 2026-10-19: an Atlas turn on gpt-6-luna opened its stream and received nothing for 53 minutes, until the socket
// died ("terminated"). Neither provider had a timeout on the stream — the SDKs' own request timeout covers the
// headers, not a body that goes quiet — so a stalled connection held the turn (and the session lock behind it) for as
// long as the network allowed. One guard for both providers (the shared-mechanism rule): the round's request gets a
// signal that aborts when nothing arrives for too long, and the round throws a clear error instead of hanging. The
// FIRST data is allowed longer than the gaps after it: a reasoning model may think before it streams anything.

import { config } from '../services/config.js'

export class StreamStalledError extends Error {
    constructor(ms, first) {
        super(`the model stopped responding — no data for ${Math.round(ms / 1000)}s${first ? ' after the request' : ''}`)
        this.name = 'StreamStalledError'
        this.code = 'stream_stalled'
    }
}

/**
 * A guard for one streamed request. `signal` is the request's (the caller's abort and the stall, together); `touch()`
 * on every chunk; `done()` when the round ends; `stalled` says whether IT was what aborted — the provider throws then,
 * instead of treating the abort as the user's Stop.
 */
export function stallGuard({ signal = null, firstMs = config.llmStallFirstMs, idleMs = config.llmStallIdleMs, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const ac = new AbortController()
    let timer = null
    let first = true
    const state = { stalled: false, error: null }
    const arm = (ms) => {
        clearTimer(timer)
        timer = setTimer(() => {
            state.stalled = true
            state.error = new StreamStalledError(ms, first)
            ac.abort(state.error)
        }, ms)
    }
    const onCallerAbort = () => { clearTimer(timer); ac.abort(signal.reason) }
    if (signal?.aborted) ac.abort(signal.reason)
    else signal?.addEventListener?.('abort', onCallerAbort, { once: true })
    arm(firstMs)
    return {
        signal: ac.signal,
        get stalled() { return state.stalled },
        get error() { return state.error },
        touch() { if (state.stalled) return; first = false; arm(idleMs) },
        done() { clearTimer(timer); signal?.removeEventListener?.('abort', onCallerAbort) },
    }
}
