// Pythia's weekly monitor — runs the change scan and its assessments when the engine has a new price run
// (docs/design/pythia-assessment.md §8; replaced the industry-screen monitor, 2026-10-11).
//
// The engine's screener job writes the price run weekly (aether-engine render.yaml, Sunday 08:00 UTC). Rather
// than a second clock that must stay in step with that one, this loop watches for the RESULT: every
// CHECK_INTERVAL_MS it asks whether the latest complete run has a finished week, and when it does not, runs
// (or resumes) one. A run the engine marked PARTIAL is never scanned (latestRun reads complete runs only).
// Opt-in (PYTHIA_WEEKLY): off, nothing is scanned or spent.

import { createPollLoop } from './pollLoop.js'
import { runWeekly } from '../services/pythiaWeekly.service.js'
import { config } from '../services/config.js'

const LOG = '[pythiaWeeklyMonitor]'
export const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000

const _deps = { enabled: () => config.pythiaWeekly, run: () => runWeekly() }
export function _setDeps(d) { Object.assign(_deps, d) }

/** One check. → the run's result, or `{ outcome: 'off' }`. Never throws (runWeekly does not). */
export async function _tick(deps = _deps) {
    if (!deps.enabled()) return { outcome: 'off' }
    return deps.run()
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: false, log: LOG, name: 'pythia weekly' })

export const pythiaWeeklyMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
