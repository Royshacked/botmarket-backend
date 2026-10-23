// DailyScreener's monitor — the overnight pass once per trading day, and the day's checkpoints
// (docs/design/daily-names.md §5–§6, build phases 2–3). Pythia's weekly monitor is the pattern: a
// poll that asks whether work is due and lets each run decide (runNightly → dueSessionDay + one
// claimed run per day; runCheckpoint → dueCheckpoint + one board per checkpoint), rather than clock
// times a restart could miss. Five minutes, because a checkpoint's window is thirty and its quotes
// are only worth having near its time. Opt-in (DAILY_SCREENER): off, nothing is read.

import { createPollLoop } from './pollLoop.js'
import { runNightly } from '../services/dailyScreener.service.js'
import { runCheckpoint, etDate } from '../services/dailyScreener.checkpoint.js'
import { runOutcomes } from '../services/hotlist.outcomes.js'
import { hotlistResearchService } from '../services/hotlistResearch.service.js'
import { catalystReadService } from '../services/catalystRead.service.js'
import { config } from '../services/config.js'

const LOG = '[dailyScreenerMonitor]'
export const CHECK_INTERVAL_MS = 5 * 60 * 1000
/** Catalyst reads are graded at most this often — a target hit or a window run out is a daily fact. */
export const GRADE_EVERY_MS = 60 * 60 * 1000

const _deps = {
    enabled: () => config.dailyScreener, nightly: () => runNightly(), outcomes: () => runOutcomes(), checkpoint: () => runCheckpoint(),
    // The short-swing chain (docs/design/horizon-chains.md §4): the 09:20 board's week picks to Prometheus, and the pick-up.
    afterCheckpoint: (r) => hotlistResearchService.afterCheckpoint(r),
    resume: (day) => hotlistResearchService.resume(day),
    gradeReads: () => catalystReadService.gradeDue(),
    now: () => Date.now(),
}
export function _setDeps(d) { Object.assign(_deps, d) }

let _gradedAt = 0
/** Test seam. */
export function _resetGrade() { _gradedAt = 0 }

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
    // Then the short-swing chain: the board that just finished (the 09:20 one hands its week picks to Prometheus), the
    // pick-up of today's names a busy or dead run left, and — hourly — the grading of the live catalyst reads.
    const research = await (deps.afterCheckpoint?.(checkpoint) ?? null)
    const resumed  = await (deps.resume?.(etDate(deps.now?.() ?? Date.now())) ?? null)
    let graded = null
    const nowMs = deps.now?.() ?? Date.now()
    if (deps.gradeReads && nowMs - _gradedAt >= GRADE_EVERY_MS) { _gradedAt = nowMs; graded = await deps.gradeReads() }
    return { nightly, outcomes, checkpoint, research, resumed, graded }
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: false, log: LOG, name: 'daily screener' })

export const dailyScreenerMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
