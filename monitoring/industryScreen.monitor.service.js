// The industry-screen monitor — publishes Pythia's weekly screen when the engine has a new run
// (docs/design/industry-screener.md §5).
//
// The engine's screener job runs weekly (aether-engine render.yaml, Sunday 08:00 UTC). Rather than a
// second clock that must stay in step with that one, this loop watches for the RESULT: every
// CHECK_INTERVAL_MS it asks whether the latest complete engine run has a screen yet, and when it does not,
// runs one. A run the engine marked PARTIAL is never screened (latestRun reads complete runs only).
// Opt-in (INDUSTRY_SCREEN): off, nothing is spent.

import { createPollLoop } from './pollLoop.js'
import { runScreen } from '../services/industryScreenRun.service.js'
import { config } from '../services/config.js'

const LOG = '[industryScreenMonitor]'
export const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000

const _deps = { enabled: () => config.industryScreen, run: () => runScreen() }
export function _setDeps(d) { Object.assign(_deps, d) }

/** One check. → the run's result, or `{ outcome: 'off' }`. Never throws (runScreen does not). */
export async function _tick(deps = _deps) {
    if (!deps.enabled()) return { outcome: 'off' }
    return deps.run()
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: false, log: LOG, name: 'industry screen' })

export const industryScreenMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
