// Prometheus's scorecard grader (services/prometheusCalls.service.js) — every 6 hours, and once at boot: the coverage
// calls whose entry or a month mark is due, and the catalyst reads and passes whose window is over (their window mark).
// The pythiaCalls grader is the pattern: daily bars only, no model, idle when nothing is due — so not gated by a flag.

import { createPollLoop } from './pollLoop.js'
import { prometheusCallsService } from '../services/prometheusCalls.service.js'
import { catalystReadService } from '../services/catalystRead.service.js'

const LOG = '[prometheusScorecard]'
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

const _deps = { calls: () => prometheusCallsService.gradeDue(), windows: () => catalystReadService.markWindows() }
export function _setDeps(d) { Object.assign(_deps, d) }

/** One pass → `{ calls, windows }`. Neither throws. */
export async function _tick(deps = _deps) {
    return { calls: await deps.calls(), windows: await deps.windows() }
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: true, log: LOG, name: 'prometheus scorecard' })

export const prometheusScorecardMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
