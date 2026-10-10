// The grader — scores Pythia's logged calls at 3 and 12 months (docs/design/pythia-assessment.md §7).
//
// Daily, it prices the basket and the benchmarks (SPY, QQQ, RSP) of every call that has reached a horizon
// it has no grade for, and writes the grade. Cheap — quotes only, no model — and idle until there are
// calls, so it is not gated behind a flag.

import { createPollLoop } from './pollLoop.js'
import { pythiaCallsService } from '../api/strategy/pythiaCalls.service.js'

const LOG = '[pythiaCallsMonitor]'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

const _deps = { grade: () => pythiaCallsService.gradeDue() }
export function _setDeps(d) { Object.assign(_deps, d) }

/** One pass → `{ graded, failed }`. gradeDue never throws per call. */
export async function _tick(deps = _deps) {
    return deps.grade()
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: false, log: LOG, name: 'pythia call grader' })

export const pythiaCallsMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
