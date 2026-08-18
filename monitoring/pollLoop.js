// The background loop primitive every monitor is built on.
//
// Lifted out of monitorUtils.js, which had accumulated four unrelated concerns — candle routing,
// LLM-reply parsing, Mongo writes, and this. A scheduling primitive shared by ten callers has
// nothing to do with fetching candles, and finding it in a module named for the other three is the
// kind of thing that gets a loop hand-rolled an eleventh time.
//
// Its own re-entrancy guard is the point: every monitor used to carry a private `_running` flag,
// and the ones that forgot it would stack ticks whenever a check ran longer than the interval.

import { logger } from '../services/logger.service.js'

/**
 * A single-flight interval loop. `start()` runs `tick` every `intervalMs` — and once immediately
 * when `eager` — but SKIPS a tick while the previous one is still running; `stop()` halts it.
 *
 * `tick` is just the loop body: it does no timer or running bookkeeping, and its throws are caught
 * and logged, so one bad tick can neither wedge the loop nor leak an unhandled rejection.
 *
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createPollLoop({ intervalMs, tick, eager = false, log = '[pollLoop]', name = 'tick' }) {
    let timer    = null
    let running  = false
    // The tick currently in flight, so `stop()` can WAIT for it. Clearing the interval only stops
    // the next tick from being scheduled; it says nothing about the one already part-way through.
    let inflight = null

    async function run() {
        if (running) { logger.warn(log, `previous ${name} still running — skipping`); return }
        running  = true
        inflight = (async () => {
            try { await tick() }
            catch (err) { logger.error(log, `${name} failed:`, err.message) }
            finally { running = false }
        })()
        await inflight
        inflight = null
    }

    return {
        start() {
            if (timer) return
            logger.info(log, `${name} loop starting`)
            if (eager) run()
            timer = setInterval(run, intervalMs)
        },
        /**
         * Halt the loop, and AWAIT the tick already running.
         *
         * The await is the part that matters at shutdown. Without it `stop()` returns while a tick
         * is still mid-Mongo-write or mid-broker-call, and the shutdown sequence walks straight on
         * to `closeDb()` and pulls the connection out from under it — which is the exact "killed
         * part-way through placing an exit" this whole path exists to prevent.
         *
         * Returns a promise; awaiting it is optional, so the sync callers that predate this are
         * unaffected.
         */
        async stop() {
            if (timer) {
                clearInterval(timer)
                timer = null
                logger.info(log, `${name} loop stopped`)
            }
            // Outside the guard on purpose: an eager loop can have a tick in flight before the
            // interval is even set, and a second stop() must still wait rather than race ahead.
            if (inflight) await inflight
        },
    }
}
