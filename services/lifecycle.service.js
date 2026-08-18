// The process lifecycle: which background loops are running, and how they are brought down.
//
// WHY THIS EXISTS. `server.js` started eleven loops with eleven bare `x.start()` calls, and every
// one of those loops exports a `stop()` that nothing in the repository ever called. Shutdown was
// `server.close()` and nothing else, so on every SIGTERM — which is what a deploy sends — the
// loops kept ticking while the HTTP server drained. `execution.reconciler` can be part-way through
// `read the idea → ask the broker whether the position survived → place / cancel exits` when the
// platform's SIGKILL lands, which is a real order lost on a routine deploy.
//
// It compounded: `server.close()` waits for open connections, and this app's connections are SSE
// streams that are long-lived BY DESIGN with a 30s heartbeat. The callback could simply never fire.
//
// So the registry is not bookkeeping for its own sake. It is the list something has to hold for
// `stopLoops()` to be writable at all, and holding it here means adding a twelfth loop is one line
// that cannot forget to be shut down — the same reason `createDueLoop` exists one layer down.

import { logger } from './logger.service.js'

const LOG = '[lifecycle]'

/** @type {{ name: string, loop: { start: Function, stop: Function } }[]} */
const _loops = []

let _draining = false

/**
 * Start a background loop and register it for shutdown. The registration is the point — a loop
 * started any other way is a loop nothing will stop.
 *
 * A loop whose `start()` throws is NOT registered and does not take the boot down with it: one
 * broken monitor should cost that monitor, not the ten that work. It is logged at error, which is
 * the loudest thing available before the server is even listening.
 *
 * @param {string} name  how it appears in the shutdown log and on /api/health
 * @param {{ start: Function, stop: Function }} loop
 * @returns {boolean} whether it started
 */
export function startLoop(name, loop) {
    if (typeof loop?.start !== 'function' || typeof loop?.stop !== 'function') {
        logger.error(LOG, `${name} is not a loop (needs start + stop) — not started`)
        return false
    }
    try {
        loop.start()
        _loops.push({ name, loop })
        return true
    } catch (err) {
        logger.error(LOG, `${name} failed to start:`, err?.message ?? err)
        return false
    }
}

/**
 * Stop every registered loop, newest first.
 *
 * NEVER THROWS, and never lets one bad `stop()` strand the rest — that is the whole contract. A
 * shutdown path that can throw half way through is worse than no shutdown path, because it leaves
 * an arbitrary subset of the fleet running while the caller believes it is done.
 *
 * Reverse order so a loop that was started later (and may therefore depend on an earlier one) is
 * the first to go, mirroring how the boot built them up.
 *
 * Idempotent: the registry is emptied as it goes, so a second call is a no-op. Both signal handlers
 * and the test teardown can call it blind.
 *
 * @returns {Promise<string[]>} the names actually stopped
 */
export async function stopLoops() {
    const stopped = []
    while (_loops.length) {
        const { name, loop } = _loops.pop()
        try {
            await loop.stop()
            stopped.push(name)
        } catch (err) {
            logger.error(LOG, `${name} failed to stop:`, err?.message ?? err)
        }
    }
    return stopped
}

/** Names of the loops currently registered — what /api/health reports. */
export function loopNames() {
    return _loops.map(l => l.name)
}

/**
 * Flip the process into draining. Readiness answers 503 from here on, so a load balancer takes us
 * out of rotation BEFORE the sockets start closing — the difference between a clean deploy and a
 * handful of requests that arrive at a server already tearing itself down.
 *
 * One-way on purpose. A process that has begun shutting down never becomes ready again.
 */
export function markDraining() {
    _draining = true
}

export function isDraining() {
    return _draining
}

/** Test seam — clears the registry and the draining latch. Never called by the server. */
export function _reset() {
    _loops.length = 0
    _draining = false
}
