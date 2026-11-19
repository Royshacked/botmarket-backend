// Echo's pipeline loop (services/echoPipeline.service.js; docs/design/echo-pipeline.md) — every hour, and once at boot:
//   · every 3 hours, the INTAKE (Step 1, echoIntake): the sources read, the new items triaged, the events stored;
//   · every hour, every open event moves along the simulator doc's steps — mapped, scored, and checked at its day-5
//     close. Hourly is enough: a check waits for a close, and a new event waits at most an hour for its map.
// ECHO_PIPELINE=true turns it on (opt-in until it replaces the engine's nightly forward test).

import { createPollLoop } from './pollLoop.js'
import { echoPipelineService } from '../services/echoPipeline.service.js'
import { echoIntakeService } from '../services/echoIntake.service.js'
import { config } from '../services/config.js'
import { logger } from '../services/logger.service.js'

const LOG = '[echoPipeline]'
export const CHECK_INTERVAL_MS = 60 * 60 * 1000
export const INTAKE_EVERY_MS = 3 * 60 * 60 * 1000

let _lastIntake = null   // never: the first pass runs it
const _deps = { tick: () => echoPipelineService.tick(), intake: () => echoIntakeService.intake(), on: () => config.echoPipeline, now: () => Date.now() }
export function _setDeps(d) { Object.assign(_deps, d) }
export function _reset() { _lastIntake = null }

/** One pass; off → nothing. Never throws. */
export async function _tick(deps = _deps) {
    if (!deps.on()) return { off: true }
    let intake = null
    if (_lastIntake == null || deps.now() - _lastIntake >= INTAKE_EVERY_MS) {
        _lastIntake = deps.now()
        try { intake = await deps.intake() } catch (err) { logger.warn(LOG, 'intake failed', { error: err.message }) }
    }
    return { intake, ...await deps.tick() }
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: true, log: LOG, name: 'echo pipeline' })

export const echoPipelineMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
