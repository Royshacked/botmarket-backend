// THE SHORT-SWING CHAIN, BY ITSELF — Hotlist → Argus → Prometheus (docs/design/horizon-chains.md §4; Roy, 2026-10-23:
// "I want this to work automatically — without the user having to activate Argus or Prometheus").
//
// After the overnight WEEK board (hotlist.week — the run-up rule; hotlist-day-archive.md, 2026-10-25: Roy, "Prometheus
// reads every run-up name"), EVERY name on it goes to the research queue (source `hotlist`), the board's facts on the
// row, and Prometheus reads each one as a CATALYST READ (analyst_mode_catalyst.md → catalystRead.service): a catalyst
// target, what is still open, a window. (Before it, Argus's picks on the 09:20 `preopen` board — weekPicks still reads
// those for an old board.)
//
// THE SAME PIPE AS THE PYTHIA WEEK (houseResearch.researchQueued / resumeQueued): this module owns the Hotlist's names,
// its DAILY caps — HOTLIST_RESEARCH_MAX_NAMES queued a day, HOTLIST_RESEARCH_MAX_USD spent a day, both read back from
// the queue — and when it runs; the run, the budget arithmetic and the pick-up of a dead run are shared.
//
// A DAY'S ROWS are the ones whose context carries that session date (`context.day`), not the ones created since a UTC
// midnight — that is 20:00 ET the day before, and a late catch-up would have spent the next day's caps (code review
// 2026-10-24). A day's rows still waiting when the next session's pick-up runs are EXPIRED: a week pick's board is a
// day old, and a waiting row would block the name for every desk.
//
// A USER can ask for a read on a This week row Argus did not pick (`requestRead`, the Hotlist's "Catalyst read"): the
// same queue and mode, outside the house's daily $ and counted instead (HOTLIST_MANUAL_READS a day, everyone's).
//
// Driven by the screener's monitor (every 5 minutes, DAILY_SCREENER): `afterCheckpoint` on the board that just
// finished, `resume` on every tick — so a run that was busy (the Pythia week's, a sleeve's) or died is picked up the
// next tick, and a board whose picks a dead process never queued is caught up (its `research_queued_at` stamp is
// missing). HOTLIST_RESEARCH=false is the kill switch for the house's reads. Never throws.

import { getDb } from '../providers/mongodb.provider.js'
import { researchQueueService } from './researchQueue.service.js'
import { researchRunService } from './researchRun.service.js'
import { researchQueued, resumeQueued } from './houseResearch.service.js'
import { boardById, seedFacts } from './hotlist.service.js'
import { BOARDS } from './hotlist.outcomes.js'
import { latestBoard } from './hotlist.boards.js'
import { boardId as weekBoardId, CHECKPOINT as OVERNIGHT } from './hotlist.week.js'
import { catalystReadService } from './catalystRead.service.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[hotlistResearch]'
const SOURCE = 'hotlist'
const HOUSE = 'house'
/** The board whose "this week" names are read: the overnight week board (hotlist.week). */
export const READ_CHECKPOINT = 'week'
const COLUMN = 'week'
const WAITING = ['queued', 'in_research']

const _deps = {
    enabled:      () => config.hotlistResearch,
    maxNames:     () => config.hotlistResearchMaxNames,
    maxUsd:       () => config.hotlistResearchMaxUsd,
    manualMax:    () => config.hotlistManualReads,
    board:        (id) => boardById(id),
    // The latest board's day — a read is asked for on that list, today's or (a weekend, before the 08:00 board) the last one.
    latestDay:    () => latestBoard().then(b => b?.day ?? null),
    // The newest board — the overnight one for the NEXT session, built the evening before (resume's catch-up).
    latestBoard:  () => latestBoard(),
    markBoard:    async (id, at) => { const db = await getDb(); await db.collection(BOARDS).updateOne({ id }, { $set: { research_queued_at: at } }) },
    liveSymbols:  () => catalystReadService.liveSymbols(),
    enqueue:      (row) => researchQueueService.enqueue(row),
    reject:       (id, reason) => researchQueueService.reject(id, reason),
    listQueue:    (q) => researchQueueService.listQueue(q),
    requeueStale: (o) => researchQueueService.requeueStale(o),
    startRun:     (o) => researchRunService.startRun(o),
    getRun:       () => researchRunService.getRun(),
    now:          () => Date.now(),
}
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * The lower bound of a day's rows' query: the PREVIOUS weekday's UTC midnight. The overnight week board for `day` is built
 * the evening before (about 18:20 ET — after `day`'s own UTC midnight is still hours away), so its rows predate the day
 * itself; a bound at `day`'s midnight found none of them and Prometheus read nothing (code review 2026-10-25). The rows
 * are then held to their session date (`context.day`), so the wider bound lets in no other day's. Pure.
 */
export function dayStart(day) {
    let t = Date.parse(`${day}T12:00:00Z`)
    do { t -= 86_400_000 } while ([0, 6].includes(new Date(t).getUTCDay()))
    return `${new Date(t).toISOString().slice(0, 10)}T00:00:00.000Z`
}
/** The board the chain reads on a day. */
export const readBoardId = (day) => weekBoardId(day)
const _house = (r) => (r.requestedBy ?? HOUSE) === HOUSE

/**
 * The week names a board hands Prometheus: on the overnight board EVERY name the rule listed (its order — one rule, no
 * ranking); on an older checkpoint board Argus's picks, his order. Pure.
 */
export function weekPicks(board) {
    if (board?.checkpoint === OVERNIGHT) return (board.rows ?? []).filter(r => r.cells?.[COLUMN]?.grade)
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
        // Argus's why on an older board. The overnight board's names were LISTED by the run-up rule, not picked (code
        // review 2026-10-25: its reason in `why` told Prometheus "Argus picked it") — `rule`, and the facts carry its reason.
        why: p.why ?? null, caution: p.caution ?? null,
        ...(board.checkpoint === OVERNIGHT ? { rule: true } : {}),
        facts: seedFacts(row, COLUMN),
        // The report inside the window (the board's run-up): the read's window ends the session before it.
        exit_before: row.cells?.[COLUMN]?.exit_before ?? null,
        // The stock's daily range: a target that leaves less than half of it open is too small to trade (minOpenPct).
        atr_pct: Number.isFinite(row.atr_pct) ? row.atr_pct : null,
        catalyst: row.catalyst ? { type: row.catalyst.type ?? null, headline: row.catalyst.headline ?? null, surprise: row.catalyst.surprise ?? null, material: row.catalyst.material ?? null } : null,
    }
}

/** The day's Hotlist rows in the queue (any status, anyone's), oldest first — by their session date. Null on a failed read. */
async function _today(day, deps) {
    const rows = await deps.listQueue({ source: SOURCE, since: dayStart(day), limit: 500 })
    return rows === null ? null : rows.filter(r => r.context?.day === day)
}

/**
 * Queue the board's week picks, inside the day's name cap → `{ queued: [symbols], skipped, live }`. A name the day
 * already has a row for (any status — a finished read is not bought twice), or with a LIVE read, is not queued and not
 * counted; one already waiting for this kind at the queue is its duplicate. The cap counts the house's rows only.
 */
export async function queueWeekPicks(board, deps = _deps) {
    const picks = weekPicks(board)
    if (!picks.length) return { queued: [], skipped: 0, live: 0 }
    const already = await _today(board.day, deps)
    if (already === null) return { queued: [], skipped: picks.length, live: 0, error: 'queue_unavailable' }
    const live = await Promise.resolve(deps.liveSymbols()).catch(() => new Set()) ?? new Set()
    const seen = new Set(already.map(r => r.symbol))
    let room = Math.max(0, (Number(deps.maxNames()) || 0) - already.filter(_house).length)
    const queued = []
    let skipped = 0, liveCount = 0
    for (const row of picks) {
        if (seen.has(row.symbol)) continue
        if (live.has(row.symbol)) { liveCount++; continue }
        if (room <= 0) { skipped++; continue }
        const q = await deps.enqueue({ symbol: row.symbol, source: SOURCE, requestedBy: HOUSE, context: hotlistContext(board, row) })
        if (q?.ok && !q.duplicate) { queued.push(row.symbol); room-- }
    }
    if (queued.length || skipped || liveCount) logger.info(LOG, 'week picks queued', { board: board.id, queued: queued.length, skipped_cap: skipped, live_read: liveCount })
    return { queued, skipped, live: liveCount }
}

/** Queue a board's picks and stamp it — the stamp is what tells the pick-up the hand-off happened, whatever it queued. */
async function _handOff(board, deps) {
    const q = await queueWeekPicks(board, deps)
    if (q.error) return q
    await Promise.resolve(deps.markBoard(board.id, new Date(deps.now()).toISOString())).catch(err => logger.warn(LOG, 'board not stamped', { board: board.id, error: err.message }))
    return q
}

/**
 * Research the day's Hotlist names that still wait. A user's waiting reads go first, with no $ budget (they were
 * counted when asked for); then the house's, inside the day's budget — the house's own rows of that day. `houseToo`
 * false: only the users' (the house's reads are switched off).
 */
export async function researchDay(day, deps = _deps, { houseToo = true } = {}) {
    const rows = await _today(day, deps)
    if (rows === null) return { ok: false, outcome: 'queue_unavailable' }
    const waiting = (pred) => [...new Set(rows.filter(r => r.status === 'queued' && pred(r)).map(r => r.symbol))]
    const users = waiting(r => !_house(r))
    if (users.length) return researchQueued({ symbols: users, since: dayStart(day), source: SOURCE, maxUsd: Infinity, budgetSince: dayStart(day), spentBy: () => false }, deps)
    if (!houseToo) return { ok: true, outcome: 'nothing_queued' }
    return researchQueued({ symbols: waiting(_house), since: dayStart(day), source: SOURCE, maxUsd: deps.maxUsd(), budgetSince: dayStart(day),
        spentBy: (r) => r.context?.day === day && _house(r) }, deps)
}

/**
 * The week board was just built → queue its names and start their research. `result` is runWeekBoard's (hotlist.week).
 * → what happened, or `{ outcome: 'not_this_board' }`.
 */
export async function afterCheckpoint(result, deps = _deps) {
    try {
        if (!deps.enabled()) return { outcome: 'off' }
        if (!['done', 'partial'].includes(result?.outcome) || !String(result?.id ?? '').endsWith(`_${READ_CHECKPOINT}`)) return { outcome: 'not_this_board' }
        const board = await deps.board(result.id)
        if (!board) return { outcome: 'no_board' }
        const q = await _handOff(board, deps)
        const research = await researchDay(board.day, deps)
        return { outcome: 'queued', queued: q.queued, research }
    } catch (err) {
        logger.warn(LOG, 'after the board — nothing queued', { error: err.message })
        return { outcome: 'error', detail: err.message }
    }
}

/**
 * Earlier days' rows still waiting — `queued`, or `in_research` that no run is on — → rejected as `expired` (their board
 * is old; a waiting row blocks the name). The claimed ones too since 2026-10-28: a claim a refused or dead run left
 * behind was never cleared, and blocked its name for good (60 on prod). The name the run is on now is left to it.
 */
export async function _expireOld(day, deps) {
    const rows = await deps.listQueue({ source: SOURCE, status: WAITING, limit: 500 })
    const run = await Promise.resolve(deps.getRun?.()).catch(() => null)
    const busy = run?.status === 'running' ? run.current : null
    const old = (rows ?? []).filter(r => (r.context?.day ?? '') < day && !(r.status === 'in_research' && r.symbol === busy))
    for (const r of old) await Promise.resolve(deps.reject(r.id, 'expired')).catch(() => null)
    if (old.length) logger.info(LOG, 'earlier days\' names expired', { expired: old.length })
    return old.length
}

/**
 * Every tick: earlier days' waiting names expired; today's week board handed off if a dead process never did (no
 * stamp); then today's names a busy or dead run left — put back in line and researched (the shared pick-up). With the
 * house's reads off, a user's waiting read is still picked up. And the NEXT session's board (built this evening): handed
 * off and researched if the evening's hand-off failed — not left until midnight ET, or Monday (code review 2026-10-25).
 */
export async function resume(day, deps = _deps) {
    const res = await _resumeDay(day, deps)
    try {
        if (!day || !deps.enabled() || !deps.latestBoard) return res
        const next = await Promise.resolve(deps.latestBoard()).catch(() => null)
        if (!next || !(next.day > day) || next.checkpoint !== OVERNIGHT || next.research_queued_at) return res
        const q = await _handOff(next, deps)
        const research = q.error ? null : await researchDay(next.day, deps)
        return { ...res, next: { day: next.day, queued: q.queued ?? [], research } }
    } catch (err) {
        logger.warn(LOG, 'the next board\'s catch-up failed', { error: err.message })
        return res
    }
}

async function _resumeDay(day, deps) {
    try {
        if (!day) return { outcome: 'off' }
        const on = deps.enabled()
        await _expireOld(day, deps)
        let caught = null
        if (on) {
            const board = await deps.board(readBoardId(day))
            if (board && !board.research_queued_at) caught = await _handOff(board, deps)
        }
        const rows = await _today(day, deps)
        if (rows === null) return { outcome: 'queue_unavailable' }
        const waiting = rows.filter(r => WAITING.includes(r.status) && (on || !_house(r)))
        if (!waiting.length) return { outcome: caught ? 'caught_up' : on ? 'nothing_queued' : 'off', ...(caught ? { queued: caught.queued } : {}) }
        const res = await resumeQueued([...new Set(waiting.map(r => r.symbol))], () => researchDay(day, deps, { houseToo: on }), deps, { now: deps.now(), source: SOURCE })
        return caught ? { ...res, outcome: res.outcome === 'started' ? 'caught_up' : res.outcome, queued: caught.queued } : res
    } catch (err) {
        logger.warn(LOG, 'pick-up failed', { error: err.message })
        return { outcome: 'error', detail: err.message }
    }
}

/**
 * A user asked for a catalyst read on a This week row (the Hotlist's "Catalyst read") → `{ ok, outcome }`: `started`,
 * `queued` (a run is going — it is read after it), or `{ ok: false, reason }`: `no_board`, `stale_board` (not the latest board's day — Roy, 2026-10-24: on a weekend "today's" refused Friday's list),
 * `not_on_week`, `live_read`, `already_queued`, `daily_cap`, `queue_unavailable`.
 */
export async function requestRead({ boardId, symbol, userId }, deps = _deps) {
    const sym = String(symbol ?? '').toUpperCase().trim()
    const board = await deps.board(boardId)
    if (!board) return { ok: false, reason: 'no_board' }
    if (board.day !== await deps.latestDay()) return { ok: false, reason: 'stale_board' }
    const row = board.rows?.find(r => r.symbol === sym)
    if (!row?.cells?.[COLUMN]?.grade) return { ok: false, reason: 'not_on_week' }
    const live = await Promise.resolve(deps.liveSymbols()).catch(() => new Set()) ?? new Set()
    if (live.has(sym)) return { ok: false, reason: 'live_read' }
    const rows = await _today(board.day, deps)
    if (rows === null) return { ok: false, reason: 'queue_unavailable' }
    if (rows.some(r => r.symbol === sym && WAITING.includes(r.status))) return { ok: false, reason: 'already_queued' }
    if (rows.filter(r => !_house(r)).length >= (Number(deps.manualMax()) || 0)) return { ok: false, reason: 'daily_cap' }
    const q = await deps.enqueue({ symbol: sym, source: SOURCE, requestedBy: String(userId ?? 'user'), context: { ...hotlistContext(board, row), requested: true } })
    if (!q?.ok) return { ok: false, reason: 'queue_unavailable' }
    if (q.duplicate) return { ok: false, reason: 'already_queued' }
    logger.info(LOG, 'catalyst read asked for', { symbol: sym, board: board.id })
    const res = await researchQueued({ symbols: [sym], since: dayStart(board.day), source: SOURCE, maxUsd: Infinity, budgetSince: dayStart(board.day), spentBy: () => false }, deps)
    return { ok: true, outcome: res.outcome === 'started' ? 'started' : 'queued' }
}

export const hotlistResearchService = { afterCheckpoint, resume, queueWeekPicks, researchDay, requestRead }
