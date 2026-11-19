// Echo's hand-off (services/echoReads.service.js; docs/design/echo-desk.md §6) — every 6 hours, and once at boot: the
// forward-test events whose day-5 check froze since the last pass send their LAGGING names to Prometheus (swing coverage)
// and Proteus (the profile), once each; Echo's waiting rows are researched inside its weekly budget. The engine checks at
// 01:00 UTC on weekdays, so a 6-hour pass reaches a new check before the US open. ECHO_READS=false turns it off (the
// tick returns at once).

import { createPollLoop } from './pollLoop.js'
import { echoReadsService } from '../services/echoReads.service.js'

const LOG = '[echoReads]'
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

const _deps = { handOff: () => echoReadsService.handOffFlagged() }
export function _setDeps(d) { Object.assign(_deps, d) }

/** One pass. Never throws (handOffFlagged does not). */
export async function _tick(deps = _deps) {
    return deps.handOff()
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: true, log: LOG, name: 'echo reads' })

export const echoReadsMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
