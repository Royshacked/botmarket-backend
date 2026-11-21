// ONE turn at a time per session (unified-chat plan phase 5b).
//
// Nothing stopped two turns from running on one session at once — a user turn racing a chain turn, or two
// taps — and both would read the same working state and the last write would win. A turn posted while
// another runs is QUEUED behind it: not refused (the user's message is not thrown away) and not
// interleaved (each turn reads the state the previous one left).
//
// In-process, like every request-path state here (docs/architecture/single-instance.md).

// sessionId → the tail of its queue (a promise that settles when the last queued turn is done)
const tails = new Map()
// sessionId → how many turns are queued or running
const depth = new Map()

/**
 * Run `fn` after every turn already queued on this session. Resolves with fn's result; a failure in one
 * turn never blocks the ones behind it.
 */
export function withSessionLock(sessionId, fn) {
    const key  = String(sessionId)
    const prev = tails.get(key) ?? Promise.resolve()
    depth.set(key, (depth.get(key) ?? 0) + 1)
    const run  = prev.then(() => fn())
    const tail = run.catch(() => {}).finally(() => {
        const n = (depth.get(key) ?? 1) - 1
        if (n <= 0) { depth.delete(key); if (tails.get(key) === tail) tails.delete(key) }
        else depth.set(key, n)
    })
    tails.set(key, tail)
    return run
}

/**
 * THE LANE a turn runs in (docs/design/modes-and-builders.md step 5a, 2026-11-20). Axl — and the specialists he asks
 * inside his turn — have a lane of their own, so the chat stays free while a builder works: picking General while the
 * trader built used to wait minutes behind him. Every desk turn, chain step, commit and seal keeps the session's own key,
 * exactly as before. What the two lanes both write is per-agent (state, summaries) or atomic (a row's seq); the floor
 * and the chain have their own rules (sessionTurn, chain runner).
 */
export function laneKey(sessionId, agent) {
    return agent === 'axl' ? `${sessionId}#axl` : String(sessionId)
}

// session|agent → how many of THAT agent's turns are accepted and not finished (runQueued tracks them).
const perAgent = new Map()

/**
 * Count one accepted turn of `agent` on this session until the returned release is called. The lane is shared by every
 * desk, so "is anything queued on the lane" cannot say whether THIS builder still has a turn coming (Roy's drive,
 * 2026-11-20: the analyst's turn queued behind the trader's build step made the build think it had more work in flight,
 * and it sat "building" for good).
 */
export function trackTurn(sessionId, agent) {
    const key = `${sessionId}|${agent}`
    perAgent.set(key, (perAgent.get(key) ?? 0) + 1)
    let done = false
    return () => {
        if (done) return
        done = true
        const n = (perAgent.get(key) ?? 1) - 1
        if (n <= 0) perAgent.delete(key); else perAgent.set(key, n)
    }
}

/** How many of `agent`'s turns are accepted and not finished on this session (the one running counts). */
export function agentDepth(sessionId, agent) {
    return perAgent.get(`${sessionId}|${agent}`) ?? 0
}

/** Whether a turn is queued or running on this session. */
export function sessionBusy(sessionId) {
    return (depth.get(String(sessionId)) ?? 0) > 0
}

/** How many turns are queued or running on this session (the one running counts) — 0 when idle. */
export function sessionDepth(sessionId) {
    return depth.get(String(sessionId)) ?? 0
}
