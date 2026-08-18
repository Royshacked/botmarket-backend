// Whether THIS process is the one running the background loops.
//
// A single boolean in its own module for one reason: `server.js` owns the lease and
// `api/health/health.routes.js` needs to report it, and health cannot import server.js — server.js
// imports health. Putting the flag in `instanceLock.service.js` would not work either, since that
// module is a factory and the answer belongs to the one lock the server happens to have built.
//
// Deliberately NOT part of lifecycle.service.js. `loopNames().length` already says how many loops
// are RUNNING; this says why. Zero loops on a follower is correct and healthy, zero loops on a
// leader is an incident — the same number, opposite meanings, and one flag is what tells them apart
// from outside the process.

let _leader = false

/** Set by the lease's onAcquired / onLost, and by nothing else. */
export function setLoopLeader(is) {
    _leader = Boolean(is)
}

export function isLoopLeader() {
    return _leader
}
