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
    let timer   = null
    let running = false

    async function run() {
        if (running) { logger.warn(log, `previous ${name} still running — skipping`); return }
        running = true
        try { await tick() }
        catch (err) { logger.error(log, `${name} failed:`, err.message) }
        finally { running = false }
    }

    return {
        start() {
            if (timer) return
            logger.info(log, `${name} loop starting`)
            if (eager) run()
            timer = setInterval(run, intervalMs)
        },
        stop() {
            if (!timer) return
            clearInterval(timer)
            timer = null
            logger.info(log, `${name} loop stopped`)
        },
    }
}
