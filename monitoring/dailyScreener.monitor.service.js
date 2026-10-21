// DailyScreener's monitor — runs the overnight pass once per trading day (docs/design/daily-names.md
// §6, build phase 2). Pythia's weekly monitor is the pattern: a poll that asks whether the work is
// due and lets the run decide (runNightly: dueSessionDay + one claimed run document per day), rather
// than a clock time that a restart could miss. Opt-in (DAILY_SCREENER): off, nothing is read.

import { createPollLoop } from './pollLoop.js'
import { runNightly } from '../services/dailyScreener.service.js'
import { config } from '../services/config.js'

const LOG = '[dailyScreenerMonitor]'
export const CHECK_INTERVAL_MS = 30 * 60 * 1000

const _deps = { enabled: () => config.dailyScreener, run: () => runNightly() }
export function _setDeps(d) { Object.assign(_deps, d) }

/** One check. → the run's result, or `{ outcome: 'off' }`. Never throws (runNightly does not). */
export async function _tick(deps = _deps) {
    if (!deps.enabled()) return { outcome: 'off' }
    return deps.run()
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: false, log: LOG, name: 'daily screener' })

export const dailyScreenerMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
