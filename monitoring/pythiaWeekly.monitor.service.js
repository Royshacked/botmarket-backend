// Pythia's weekly monitor — runs the change scan and its assessments when the engine has a new price run
// (docs/design/pythia-assessment.md §8; replaced the industry-screen monitor, 2026-10-11).
//
// The engine's screener job writes the price run weekly (aether-engine render.yaml, Sunday 08:00 UTC). Rather
// than a second clock that must stay in step with that one, this loop watches for the RESULT: every
// CHECK_INTERVAL_MS it asks whether the latest complete run has a finished week, and when it does not, runs
// (or resumes) one. A run the engine marked PARTIAL is never scanned (latestRun reads complete runs only).
// Opt-in (PYTHIA_WEEKLY): off, nothing is scanned or spent.

import { createPollLoop } from './pollLoop.js'
import { runWeekly, resumeResearch } from '../services/pythiaWeekly.service.js'
import { config } from '../services/config.js'

const LOG = '[pythiaWeeklyMonitor]'
export const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000

const _deps = { enabled: () => config.pythiaWeekly, run: () => runWeekly(), resume: () => resumeResearch() }
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * One check. → the run's result (with the research pick-up's as `research`), or `{ outcome: 'off' }`. Never throws
 * (neither callee does). After the week, the latest done week's research is picked up (house-research-chain.md
 * step 6): names a dead run left, or a budget that waited on a busy run.
 */
export async function _tick(deps = _deps) {
    if (!deps.enabled()) return { outcome: 'off' }
    const week = await deps.run()
    const research = await deps.resume()
    return { ...week, research }
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: false, log: LOG, name: 'pythia weekly' })

export const pythiaWeeklyMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
