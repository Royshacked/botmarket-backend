// The HOTLIST's read side (docs/design/daily-names.md §8, build phase 5): what the Floor's Hotlist
// row and the API read, and what a "Build with Mentor" hand-off is resolved into.
//
// The boards are written by dailyScreener.checkpoint and scored by hotlist.outcomes; nothing here
// writes. A hand-off from the board is a REFERENCE (scanSeed.util: board id + column + the ticker),
// and the facts Mentor is told come from the stored board — never from the request.

import { getDb } from '../providers/mongodb.provider.js'
import { BOARDS, outcomeSummary } from './hotlist.outcomes.js'
import { COLUMN_WORDS } from './hotlist.argus.js'
import { RUNS, latestRun, runIsLive } from './dailyScreener.service.js'
import { BOARD_STALE_MS } from './dailyScreener.checkpoint.js'
import { rowStatus, STATUSES } from './hotlist.columns.js'

/** The trade horizon each column hands Mentor (entity/vocabulary TRADE_HORIZONS). */
export const COLUMN_HORIZON = Object.freeze({
    open: 'intraday', mid: 'intraday', eod: 'intraday', tomorrow: 'day', week: 'short term swing',
})

const _deps = { db: () => getDb(), summary: () => outcomeSummary(), now: () => Date.now(), latestRun: () => latestRun() }
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

const _f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : null)

/**
 * The board's facts about one name in one column, as one line Mentor can relay. Pure.
 * e.g. "mid-session B — +10.14% gap, 3.39× volume; free range 2.09% (0.45× ATR) to 166.18;
 *       catalyst: drift, positive — 'SpaceX swings to profit…'; Argus: <why> Caution: <caution>"
 */
export function seedFacts(row, column) {
    const c = row?.cells?.[column]
    if (!c?.grade) return null
    const parts = [`${COLUMN_WORDS[column] ?? column} ${c.grade}`]
    const tape = [row.gap_pct != null ? `${row.gap_pct > 0 ? '+' : ''}${_f(row.gap_pct)}% gap` : null, row.rvol != null ? `${row.rvol}× volume` : null].filter(Boolean)
    if (tape.length) parts[0] += ` — ${tape.join(', ')}`
    parts.push(c.range?.open_sky ? 'open sky (no level overhead)' : `free range ${_f(c.range?.pct)}% (${_f(c.range?.atr_mult)}× ATR) to ${_f(c.range?.level)}`)
    if (row.catalyst?.material) parts.push(`catalyst: ${row.catalyst.type}, ${row.catalyst.surprise}${row.catalyst.headline ? ` — "${row.catalyst.headline}"` : ''}`)
    // A report inside the window makes this a run-up trade (§2.7): Mentor's exit has to come before it.
    if (c.exit_before) parts.push(`earnings ${c.exit_before} — a run-up into the report: the setup must be out before it`)
    else if (row.next_earnings) parts.push(`earnings ${row.next_earnings}`)
    if (row.fade_check) parts.push('flagged: a minor story under a big gap')
    return parts.join('; ')
}

/**
 * Resolve a hotlist hand-off reference into the seed fields Mentor reads. → `{ horizon, hotlist_facts,
 * thesis?, caution?, unverified }`, or null when the board, the row or a graded cell is not there
 * (a stale tab, a pruned board) — the seed then goes on as an ordinary one.
 */
export async function hotlistSeed(ref, deps = _deps) {
    if (!ref?.board || !ref?.column || !ref?.symbol) return null
    const db = await deps.db()
    const board = await db.collection(BOARDS).findOne({ id: ref.board })
    const row = board?.rows?.find(r => r.symbol === ref.symbol)
    const facts = seedFacts(row, ref.column)
    if (!facts) return null
    return {
        horizon:       COLUMN_HORIZON[ref.column] ?? null,
        hotlist_facts: facts,
        board_day:     board.day,
        checkpoint:    board.checkpoint,
        unverified:    (board.unverified_columns ?? [ref.column]).includes(ref.column),
        // His pick for THIS column (horizon-chains.md §2); a board from before per-column picks has only `pick`.
        ...(() => {
            const p = row.picks?.[ref.column] ?? (row.picks ? null : row.pick)
            return p ? { thesis: p.why ?? null, caution: p.caution ?? null } : {}
        })(),
    }
}

/**
 * Today's hotlist for the Floor and the API: the latest board (rows and all) and the day's
 * checkpoints as one-liners. `day` defaults to the latest day that has a board. Also what the
 * screener is doing right now (`working`) and its latest finished overnight pass (`stats`), so an
 * empty board can say "preparing" or "ready" instead of nothing (Roy, 2026-10-22).
 */
export async function todayHotlist({ day = null, deps = _deps } = {}) {
    const db = await deps.db()
    const coll = db.collection(BOARDS)
    const [working, stats] = await Promise.all([_working(db, coll, deps), _stats(deps)])
    const done = { status: { $in: ['done', 'partial'] } }
    const latest = await coll.find({ ...done, ...(day ? { day } : {}) }).sort({ finished_at: -1 }).limit(1).next()
    if (!latest) return { day: day ?? null, latest: null, checkpoints: [], working, stats }
    const ofDay = await coll.find({ ...done, day: latest.day }, { projection: { id: 1, checkpoint: 1, finished_at: 1, status: 1, columns: 1, argus: 1, counts: 1, rows: 1 } })
        .sort({ finished_at: 1 }).toArray()
    return {
        day: latest.day,
        latest: _public(latest),
        checkpoints: ofDay.map(b => ({ id: b.id, checkpoint: b.checkpoint, status: b.status, columns: b.columns, finished_at: b.finished_at, rows: b.counts?.graded ?? null, argus: !!b.argus })),
        day_list: dayList(ofDay),
        working,
        stats,
    }
}

/**
 * The day's WATCHLIST (Roy, 2026-10-22): every name any of the day's boards graded, once. Pure.
 * `boards` in the order they finished. A name keeps the cell of every column it was graded on — each
 * from the latest board that graded that column, with that board's id in `cell_board` (a Mentor
 * hand-off references the board the cell lives on). Price, tape, catalyst and Argus's pick/avoid are
 * the latest board's that listed the name; `first_seen` and `seen` are the checkpoints. Prices are as
 * of each name's last checkpoint (`quoted_at`), never live.
 */
export function dayList(boards) {
    const by = new Map()
    for (const b of boards ?? []) {
        for (const row of b.rows ?? []) {
            const prev = by.get(row.symbol)
            const graded = Object.entries(row.cells ?? {}).filter(([, c]) => c?.grade)
            // A later board that quoted the name and left a column UNGRADED has taken that grade back
            // (08:00 week B, then 09:20 not in play for the week): the earlier cell goes. A name a later
            // board did not list at all keeps its cells — it may simply not have been quoted.
            const revoked = new Set(Object.entries(row.cells ?? {}).filter(([, c]) => c && !c.grade).map(([col]) => col))
            const keep = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([col]) => !revoked.has(col)))
            const { pick, picks, avoid, cells, ...rest } = row
            // Argus's picks per column (horizon-chains.md §2), by the cells' rule: a column this board graded takes
            // ITS pick (or none — he did not pick it this time); a column it did not grade keeps the earlier one.
            const gradedCols = new Set(graded.map(([c]) => c))
            const keptPicks = Object.fromEntries(Object.entries(keep(prev?.picks)).filter(([c]) => !gradedCols.has(c)))
            const mergedPicks = { ...keptPicks, ...(picks ?? {}) }
            const merged = {
                ...rest,
                ...(pick ? { pick } : {}),
                ...(Object.keys(mergedPicks).length ? { picks: mergedPicks } : {}),
                ...(avoid ? { avoid } : {}),
                cells:      { ...keep(prev?.cells), ...Object.fromEntries(graded) },
                cell_board: { ...keep(prev?.cell_board), ...Object.fromEntries(graded.map(([c]) => [c, b.id])) },
                first_seen: prev?.first_seen ?? b.checkpoint,
                seen:       [...(prev?.seen ?? []), b.checkpoint],
                board:      b.id,
                checkpoint: b.checkpoint,
            }
            // Every grade taken back and none left: the name is off the list.
            if (!Object.keys(merged.cells).length) { by.delete(row.symbol); continue }
            merged.status = rowStatus(merged.cells) ?? _legacyStatus(row)
            by.set(row.symbol, merged)
        }
    }
    const rank = (s) => { const i = STATUSES.indexOf(s); return i < 0 ? STATUSES.length : i }
    const picked = (r) => (r.pick || (r.picks && Object.keys(r.picks).length) ? 0 : 1)
    return [...by.values()].sort((a, b) => picked(a) - picked(b) || rank(a.status) - rank(b.status) || a.symbol.localeCompare(b.symbol))
}

// Rows written before 2026-10-22 carry no week `path`: a material story on the row means it came in
// on the story, otherwise on its date.
function _legacyStatus(row) {
    return row.status ?? (row.catalyst?.material ? 'in_play' : 'setting_up')
}

/**
 * What the screener is doing right now: a checkpoint building its board, else the overnight pass
 * with its count — or null. A `running` older than its pass's stale limit is a dead process's, not work.
 */
async function _working(db, boards, deps) {
    const now = deps.now()
    const board = await boards.find({ status: 'running', started_at: { $gt: now - BOARD_STALE_MS } })
        .sort({ started_at: -1 }).limit(1).next()
    if (board) return { kind: 'board', day: board.day ?? null, checkpoint: board.checkpoint ?? null, started_at: board.started_at }
    // The pass's own liveness rule — its heartbeat, else its start (dailyScreener.service runIsLive).
    const run = (await db.collection(RUNS).find({ status: 'running' }).sort({ started_at: -1 }).limit(5).toArray())
        .find(r => runIsLive(r, now))
    if (run) return { kind: 'overnight', day: run.day ?? null, started_at: run.started_at, done: run.progress?.done ?? null, of: run.progress?.of ?? null }
    return null
}

/** The latest finished overnight pass, in brief — or null before the first. */
async function _stats(deps) {
    const run = await deps.latestRun()
    return run ? { day: run.day ?? null, status: run.status, written: run.written ?? null, finished_at: run.finished_at ?? null } : null
}

/** One board by id, or null. */
export async function boardById(id, deps = _deps) {
    const db = await deps.db()
    const b = await db.collection(BOARDS).findOne({ id: String(id) })
    return b && ['done', 'partial'].includes(b.status) ? _public(b) : null
}

/** The outcome log summarised — per column and grade, and which columns are verified. */
export async function hotlistOutcomes(deps = _deps) {
    return deps.summary()
}

/** What a client sees of a board: no Mongo id, no claim bookkeeping. Pure. */
function _public(b) {
    const { _id, started_at, scored, requests, ...rest } = b
    return rest
}
