// THE SHORT-SWING CHAIN, BY ITSELF — Hotlist → Argus → Prometheus (docs/design/horizon-chains.md §4; Roy, 2026-10-23:
// "I want this to work automatically — without the user having to activate Argus or Prometheus").
//
// After the 09:20 board (`preopen` — the open and this week, on the strict spreads), Argus's THIS WEEK picks go to the
// research queue (source `hotlist`), the board's facts and his why / caution on the row, and Prometheus reads each one
// as a CATALYST READ (analyst_mode_catalyst.md → catalystRead.service): a catalyst target, what is still open, a window.
//
// THE SAME PIPE AS THE PYTHIA WEEK (houseResearch.researchQueued / resumeQueued): this module owns the Hotlist's names,
// its DAILY caps — HOTLIST_RESEARCH_MAX_NAMES queued a day, HOTLIST_RESEARCH_MAX_USD spent a day, both read back from
// the queue — and when it runs; the run, the budget arithmetic and the pick-up of a dead run are shared.
//
// Driven by the screener's monitor (every 5 minutes, DAILY_SCREENER): `afterCheckpoint` on the board that just
// finished, `resume` on every tick — so a run that was busy (the Pythia week's, a sleeve's) or died is picked up the
// next tick. HOTLIST_RESEARCH=false is the kill switch. Never throws.

import { researchQueueService } from './researchQueue.service.js'
import { researchRunService } from './researchRun.service.js'
import { researchQueued, resumeQueued } from './houseResearch.service.js'
import { boardById, seedFacts } from './hotlist.service.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[hotlistResearch]'
const SOURCE = 'hotlist'
/** The board whose "this week" picks are read: 09:20, the strict spreads (08:00's book is thin). */
export const READ_CHECKPOINT = 'preopen'
const COLUMN = 'week'

const _deps = {
    enabled:      () => config.hotlistResearch,
    maxNames:     () => config.hotlistResearchMaxNames,
    maxUsd:       () => config.hotlistResearchMaxUsd,
    board:        (id) => boardById(id),
    enqueue:      (row) => researchQueueService.enqueue(row),
    listQueue:    (q) => researchQueueService.listQueue(q),
    requeueStale: (o) => researchQueueService.requeueStale(o),
    startRun:     (o) => researchRunService.startRun(o),
    getRun:       () => researchRunService.getRun(),
    now:          () => Date.now(),
}
export function _setDeps(d) { Object.assign(_deps, d) }

/** The day's start, for "queued today" and "spent today" — the session date's UTC midnight (before any ET board). */
export const dayStart = (day) => `${day}T00:00:00.000Z`

/** Argus's picks for the week column on a board, his order. Pure. */
export function weekPicks(board) {
    return (board?.rows ?? [])
        .filter(r => r.picks?.[COLUMN] && r.cells?.[COLUMN]?.grade)
        .sort((a, b) => (a.picks[COLUMN].rank ?? 99) - (b.picks[COLUMN].rank ?? 99))
}

/** What travels with a name to Prometheus — the board's facts and Argus's reason. Pure. */
export function hotlistContext(board, row) {
    const p = row.picks?.[COLUMN] ?? {}
    return {
        hotlist: true,
        reason: `Hotlist: this week (${board.day})`,
        day: board.day, board: board.id, column: COLUMN,
        why: p.why ?? null, caution: p.caution ?? null,
        facts: seedFacts(row, COLUMN),
        // The report inside the window (the board's run-up): the read's window ends the session before it.
        exit_before: row.cells?.[COLUMN]?.exit_before ?? null,
        catalyst: row.catalyst ? { type: row.catalyst.type ?? null, headline: row.catalyst.headline ?? null, surprise: row.catalyst.surprise ?? null, material: row.catalyst.material ?? null } : null,
    }
}

/** Today's Hotlist rows in the queue (any status), oldest first. Null on a failed read. */
async function _today(day, deps) {
    return deps.listQueue({ source: SOURCE, since: dayStart(day), limit: 500 })
}

/**
 * Queue the board's week picks, inside the day's name cap → `{ queued: [symbols], skipped }`. A name already in line
 * (any desk) is the queue's duplicate, and does not count against the cap.
 */
export async function queueWeekPicks(board, deps = _deps) {
    const picks = weekPicks(board)
    if (!picks.length) return { queued: [], skipped: 0 }
    const already = await _today(board.day, deps)
    if (already === null) return { queued: [], skipped: picks.length, error: 'queue_unavailable' }
    let room = Math.max(0, (Number(deps.maxNames()) || 0) - already.length)
    const queued = []
    let skipped = 0
    for (const row of picks) {
        if (room <= 0) { skipped++; continue }
        const q = await deps.enqueue({ symbol: row.symbol, source: SOURCE, requestedBy: 'house', context: hotlistContext(board, row) })
        if (q?.ok && !q.duplicate) { queued.push(row.symbol); room-- }
    }
    if (queued.length || skipped) logger.info(LOG, 'week picks queued', { board: board.id, queued: queued.length, skipped_cap: skipped })
    return { queued, skipped }
}

/** Research today's Hotlist names that still wait, inside the day's budget (the shared pipe). */
export async function researchDay(day, deps = _deps) {
    const rows = await _today(day, deps)
    if (rows === null) return { ok: false, outcome: 'queue_unavailable' }
    return researchQueued({ symbols: [...new Set(rows.map(r => r.symbol))], since: dayStart(day), source: SOURCE,
        maxUsd: deps.maxUsd(), budgetSince: dayStart(day) }, deps)
}

/**
 * The screener's checkpoint just ran → when it is the 09:20 board, queue its week picks and start their research.
 * `result` is runCheckpoint's. → what happened, or `{ outcome: 'not_this_board' }`.
 */
export async function afterCheckpoint(result, deps = _deps) {
    try {
        if (!deps.enabled()) return { outcome: 'off' }
        if (!['done', 'partial'].includes(result?.outcome) || !String(result?.id ?? '').endsWith(`_${READ_CHECKPOINT}`)) return { outcome: 'not_this_board' }
        const board = await deps.board(result.id)
        if (!board) return { outcome: 'no_board' }
        const q = await queueWeekPicks(board, deps)
        const research = await researchDay(board.day, deps)
        return { outcome: 'queued', queued: q.queued, research }
    } catch (err) {
        logger.warn(LOG, 'after the board — nothing queued', { error: err.message })
        return { outcome: 'error', detail: err.message }
    }
}

/**
 * Every tick: today's names a busy or dead run left — put back in line and researched (the shared pick-up). And when
 * NOTHING of today's is in the queue yet but today's 09:20 board is there, the process died between saving the board
 * and queueing its picks: they are queued now. Only on an empty day — a day that queued anything has had its turn, and
 * re-queueing a finished name would buy a second read.
 */
export async function resume(day, deps = _deps) {
    try {
        if (!deps.enabled() || !day) return { outcome: 'off' }
        const rows = await _today(day, deps)
        if (rows === null) return { outcome: 'queue_unavailable' }
        if (!rows.length) {
            const board = await deps.board(`hb_${day}_${READ_CHECKPOINT}`)
            if (!board || !weekPicks(board).length) return { outcome: 'no_names' }
            const q = await queueWeekPicks(board, deps)
            const research = q.queued.length ? await researchDay(day, deps) : null
            return { outcome: 'caught_up', queued: q.queued, research }
        }
        const waiting = rows.filter(r => ['queued', 'in_research'].includes(r.status))
        if (!waiting.length) return { outcome: 'nothing_queued' }
        return await resumeQueued([...new Set(waiting.map(r => r.symbol))], () => researchDay(day, deps), deps, { now: deps.now() })
    } catch (err) {
        logger.warn(LOG, 'pick-up failed', { error: err.message })
        return { outcome: 'error', detail: err.message }
    }
}

export const hotlistResearchService = { afterCheckpoint, resume, queueWeekPicks, researchDay }
