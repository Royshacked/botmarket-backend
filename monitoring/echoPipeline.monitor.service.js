// Echo's pipeline loop (services/echoPipeline.service.js; docs/design/echo-pipeline.md) — every hour, and once at boot:
// every open event moves along the simulator doc's steps — mapped, scored, and checked at its day-5 close. Hourly is
// enough: a check waits for a close, and a new house event waits at most an hour for its map. ECHO_PIPELINE=true turns
// it on (opt-in until it replaces the engine's nightly forward test).

import { createPollLoop } from './pollLoop.js'
import { echoPipelineService } from '../services/echoPipeline.service.js'
import { config } from '../services/config.js'

const LOG = '[echoPipeline]'
export const CHECK_INTERVAL_MS = 60 * 60 * 1000

const _deps = { tick: () => echoPipelineService.tick(), on: () => config.echoPipeline }
export function _setDeps(d) { Object.assign(_deps, d) }

/** One pass; off → nothing. Never throws (tick does not). */
export async function _tick(deps = _deps) {
    if (!deps.on()) return { off: true }
    return deps.tick()
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: true, log: LOG, name: 'echo pipeline' })

export const echoPipelineMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
