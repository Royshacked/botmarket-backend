// DailyScreener's monitor — the overnight pass once per trading day, then the WEEK board from it (docs/design/
// daily-names.md §5–§6; hotlist-day-archive.md — the day checkpoints were ARCHIVED 2026-10-25,
// archive/services/dailyScreener.checkpoint.js). Pythia's weekly monitor is the pattern: a poll that asks whether work
// is due and lets each run decide (runNightly → dueSessionDay + one claimed run per day; runWeekBoard → one board per
// run), rather than clock times a restart could miss. Five minutes: the scoring, the research pick-up and the reads'
// grading ride the same tick. Opt-in (DAILY_SCREENER): off, nothing is read.

import { createPollLoop } from './pollLoop.js'
import { runNightly } from '../services/dailyScreener.service.js'
import { etDate } from '../services/hotlist.boards.js'
import { runOutcomes } from '../services/hotlist.outcomes.js'
import { runWeekBoard } from '../services/hotlist.week.js'
import { hotlistResearchService } from '../services/hotlistResearch.service.js'
import { catalystReadService } from '../services/catalystRead.service.js'
import { config } from '../services/config.js'

const LOG = '[dailyScreenerMonitor]'
export const CHECK_INTERVAL_MS = 5 * 60 * 1000
/** Catalyst reads are graded at most this often — a target hit or a window run out is a daily fact. */
export const GRADE_EVERY_MS = 60 * 60 * 1000

const _deps = {
    enabled: () => config.dailyScreener, nightly: () => runNightly(), outcomes: () => runOutcomes(),
    // This week, overnight on the run-up rule (hotlist.week; hotlist-day-archive.md §3) — from the run just written.
    week: () => runWeekBoard(),
    // The short-swing chain (docs/design/horizon-chains.md §4): the week board's names to Prometheus, and the pick-up.
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
 * One check: the overnight pass first, then the week board from it, then the outcome scoring (off-session only, at
 * most hourly). Each is a cheap no-op when not due. → their results, or `{ outcome: 'off' }`. Never throws (none of
 * the runs does).
 */
export async function _tick(deps = _deps) {
    if (!deps.enabled()) return { outcome: 'off' }
    const nightly    = await deps.nightly()
    const week       = await (deps.week?.() ?? null)
    const outcomes   = await (deps.outcomes?.() ?? { outcome: 'not_due' })
    // Then the short-swing chain: the week board just built hands its names on (hotlistResearch afterCheckpoint — every
    // run-up name, Roy 2026-10-25), the pick-up of today's names a busy or dead run left, and — hourly — the grading of
    // the live catalyst reads.
    const research = await (deps.afterCheckpoint?.(week) ?? null)
    const resumed  = await (deps.resume?.(etDate(deps.now?.() ?? Date.now())) ?? null)
    let graded = null
    const nowMs = deps.now?.() ?? Date.now()
    if (deps.gradeReads && nowMs - _gradedAt >= GRADE_EVERY_MS) { _gradedAt = nowMs; graded = await deps.gradeReads() }
    return { nightly, week, outcomes, research, resumed, graded }
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: false, log: LOG, name: 'daily screener' })

export const dailyScreenerMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
