// DailyScreener's monitor — the overnight pass once per trading day, and the day's checkpoints
// (docs/design/daily-names.md §5–§6, build phases 2–3). Pythia's weekly monitor is the pattern: a
// poll that asks whether work is due and lets each run decide (runNightly → dueSessionDay + one
// claimed run per day; runCheckpoint → dueCheckpoint + one board per checkpoint), rather than clock
// times a restart could miss. Five minutes, because a checkpoint's window is thirty and its quotes
// are only worth having near its time. Opt-in (DAILY_SCREENER): off, nothing is read.

import { createPollLoop } from './pollLoop.js'
import { runNightly } from '../services/dailyScreener.service.js'
import { runCheckpoint } from '../services/dailyScreener.checkpoint.js'
import { runOutcomes } from '../services/hotlist.outcomes.js'
import { config } from '../services/config.js'

const LOG = '[dailyScreenerMonitor]'
export const CHECK_INTERVAL_MS = 5 * 60 * 1000

const _deps = { enabled: () => config.dailyScreener, nightly: () => runNightly(), outcomes: () => runOutcomes(), checkpoint: () => runCheckpoint() }
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * One check: the overnight pass first (before the open it is the catch-up the morning's boards
 * read from), then the outcome scoring (off-session only, at most hourly), then whichever checkpoint
 * is due. Each is a cheap no-op when not due. → all three results, or `{ outcome: 'off' }`. Never
 * throws (none of the runs does).
 */
export async function _tick(deps = _deps) {
    if (!deps.enabled()) return { outcome: 'off' }
    const nightly    = await deps.nightly()
    const outcomes   = await (deps.outcomes?.() ?? { outcome: 'not_due' })
    const checkpoint = await deps.checkpoint()
    return { nightly, outcomes, checkpoint }
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: false, log: LOG, name: 'daily screener' })

export const dailyScreenerMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
