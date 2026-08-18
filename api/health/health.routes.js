/**
 * Liveness and readiness — the two questions a deployment platform asks, which are NOT the same
 * question and must not share an answer.
 *
 *   GET /api/health        → 200 { status, uptimeSec, loops }        is the process alive?
 *   GET /api/health/ready  → 200/503 { ready, db, draining, loops }  should it receive traffic?
 *
 * LIVENESS stays 200 while the process is draining. A liveness probe failing means "restart this
 * container", and restarting a server that is already shutting down cleanly is the one thing that
 * turns an orderly deploy back into a hard kill.
 *
 * READINESS goes 503 the moment shutdown begins, so the load balancer stops routing to us BEFORE
 * `server.close()` starts refusing sockets. That gap is the whole reason the two are separate.
 *
 * UNAUTHENTICATED — a probe has no cookie — and therefore deliberately thin. It reports a loop
 * COUNT rather than the roster outside development: an anonymous endpoint should not enumerate a
 * system's internals, and the count is what actually answers "did the fleet come up?".
 *
 * NEVER CACHED, and not by choice of politeness. `res.json()` makes Express compute an ETag, and
 * the readiness body is byte-identical call to call — so a client sending `If-None-Match` gets a
 * 304 with NO BODY. A probe checking for exactly 200 reads that as an outage, and anything parsing
 * the JSON gets nothing. Caching a readiness answer is backwards anyway: the whole value is that it
 * answers NOW. Both handlers therefore write with `.end()` (which skips Express's fresh/ETag path)
 * under `Cache-Control: no-store`.
 *
 * Mounted BEFORE the rate limiters in server.js. A probe that runs every few seconds must never
 * consume the budget meant for users, and a limiter that 429s the health check reads to the
 * platform as an outage.
 */

import { Router } from 'express'
import { getDb } from '../../providers/mongodb.provider.js'
import { withTimeout } from '../../services/timeout.util.js'
import { loopNames, isDraining } from '../../services/lifecycle.service.js'
import { isLoopLeader } from '../../services/loopLeader.js'
import { config } from '../../services/config.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[health]'

// The Mongo driver waits `serverSelectionTimeoutMS` (10s) before admitting it cannot reach the
// cluster. A probe with a 5s timeout would give up first and read every slow moment as a hard
// outage, so the ping is bounded well inside both.
const PING_TIMEOUT_MS = 2_000

// Two TTLs, and the asymmetry is deliberate. A HEALTHY answer is cached long enough that a probe
// every second cannot turn into a command per second against the cluster — this endpoint is
// anonymous, so its cost has to be bounded by something other than the caller's manners. An
// UNHEALTHY answer is cached barely at all, because the useful property during an incident is
// noticing recovery quickly.
const OK_TTL_MS   = 5_000
const FAIL_TTL_MS = 1_000

let _cache = { at: 0, ok: false }

/**
 * Is Mongo answering? Cached (see the TTLs above) and NEVER throws — a readiness probe that throws
 * is a 500, which tells the platform nothing it can act on.
 */
async function _dbOk(nowMs = Date.now()) {
    const ttl = _cache.ok ? OK_TTL_MS : FAIL_TTL_MS
    if (_cache.at && (nowMs - _cache.at) < ttl) return _cache.ok

    let ok = false
    try {
        const db = await withTimeout(getDb(), PING_TIMEOUT_MS, 'db connect')
        await withTimeout(db.command({ ping: 1 }), PING_TIMEOUT_MS, 'db ping')
        ok = true
    } catch (err) {
        logger.warn(LOG, 'db ping failed:', err?.message ?? err)
    }
    _cache = { at: nowMs, ok }
    return ok
}

/** Test seam — drops the memoised ping so a suite can drive both branches. */
export function _resetHealthCache() {
    _cache = { at: 0, ok: false }
}

export const healthRoutes = Router()

/** Write JSON without Express's ETag/304 path. See the no-cache note in the header. */
function sendJson(res, status, payload) {
    res.status(status)
        .set('Cache-Control', 'no-store')
        .type('application/json')
        .end(JSON.stringify(payload))
}

// Liveness. No IO at all: the moment this needs a database to answer, it has stopped being a
// liveness check and a slow dependency starts getting the process killed and restarted.
healthRoutes.get('/', (req, res) => {
    sendJson(res, 200, {
        status:    'ok',
        uptimeSec: Math.round(process.uptime()),
        // `leader: false` with `loops: 0` is a FOLLOWER, not a fault — it means another
        // instance holds the lease and this one is deliberately idle. Distinguishing the two
        // from outside is the whole reason this field is here.
        leader:    isLoopLeader(),
        loops:     loopNames().length,
        ...(config.isProduction ? {} : { loopNames: loopNames() }),
    })
})

healthRoutes.get('/ready', async (req, res) => {
    const draining = isDraining()
    // Skip the ping entirely while draining — the answer is already 'not ready', and an outbound
    // command against a pool that shutdown is closing is a pointless way to log an error.
    const db    = draining ? 'skipped' : (await _dbOk()) ? 'up' : 'down'
    const ready = !draining && db === 'up'

    // A follower is READY: it serves HTTP correctly, it simply runs no loops. Failing readiness
    // here would take a perfectly good process out of rotation for doing the right thing.
    sendJson(res, ready ? 200 : 503, {
        ready,
        db,
        draining,
        leader: isLoopLeader(),
        loops: loopNames().length,
    })
})
