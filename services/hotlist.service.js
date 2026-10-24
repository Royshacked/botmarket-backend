// The HOTLIST's read side (docs/design/daily-names.md §8, build phase 5): what the Floor's Hotlist
// row and the API read, and what a "Build with Mentor" hand-off is resolved into.
//
// The boards are written by dailyScreener.checkpoint and scored by hotlist.outcomes; nothing here
// writes. A hand-off from the board is a REFERENCE (scanSeed.util: board id + column + the ticker),
// and the facts Mentor is told come from the stored board — never from the request.

import { getDb } from '../providers/mongodb.provider.js'
import { BOARDS, OUTCOMES, outcomeSummary, argusSummary, windowEnd, lastClosedSession } from './hotlist.outcomes.js'
import { COLUMN_WORDS } from './hotlist.argus.js'
import { RUNS, latestRun, runIsLive } from './dailyScreener.service.js'
import { backtestSummary } from './hotlistBacktest.service.js'
import { BOARD_STALE_MS } from './dailyScreener.checkpoint.js'
import { rowStatus, STATUSES } from './hotlist.columns.js'
import { catalystReadService, readFacts } from './catalystRead.service.js'

/** The trade horizon each column hands Mentor (entity/vocabulary TRADE_HORIZONS). */
export const COLUMN_HORIZON = Object.freeze({
    open: 'intraday', mid: 'intraday', eod: 'intraday', tomorrow: 'day', week: 'short term swing',
})

const _deps = { db: () => getDb(), summary: () => outcomeSummary(), argus: () => argusSummary(), backtest: () => backtestSummary(), liveRead: (s) => catalystReadService.liveRead(s), now: () => Date.now(), latestRun: () => latestRun() }
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
    // No column has a grade to hand on (Roy, 2026-10-24: the day trades, then the week) — Argus's pick, and on the week
    // Prometheus's read, are the verdict.
    const parts = [`${COLUMN_WORDS[column] ?? column}`]
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
 * catalyst_facts, thesis?, caution? }`, or null when the board, the row or a graded cell is not there (a stale tab, a
 * pruned board) — the seed then goes on as an ordinary one. No grade is handed on (2026-10-24), so nothing is unverified.
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
        // THIS WEEK: Prometheus's live catalyst read on the name — his target, the company, the window (Roy, 2026-10-24).
        // A failed read leaves the hand-off as it was, without it.
        catalyst_facts: ref.column === 'week' && deps.liveRead
            ? readFacts(await Promise.resolve().then(() => deps.liveRead(ref.symbol)).catch(() => null)) : null,
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
    // The days there are lists for, newest first — a past day is where a name's result is (Roy, 2026-10-24).
    // A projected find, not `distinct`: the client runs the Stable API strictly, and `distinct` is not in API v1 — it
    // threw on the live database while every test passed (2026-10-24). A day has at most five boards.
    const recent = await coll.find(done, { projection: { _id: 0, day: 1 } }).sort({ day: -1 }).limit(DAYS_KEPT * 5).toArray()
    const days = [...new Set(recent.map(b => b.day).filter(Boolean))].slice(0, DAYS_KEPT)
    if (!latest) return { day: day ?? null, latest: null, checkpoints: [], working, stats, days }
    const ofDay = await coll.find({ ...done, day: latest.day }, { projection: { id: 1, checkpoint: 1, finished_at: 1, status: 1, columns: 1, argus: 1, counts: 1, rows: 1 } })
        .sort({ finished_at: 1 }).toArray()
    const outcomes = await _outcomesOf(db, { day: latest.day })
    const closed = lastClosedSession(deps.now())
    const pub = _public(latest)
    return {
        day: latest.day,
        latest: { ...pub, rows: withResults(pub.rows, outcomes, { day: latest.day, closed, boardOf: () => latest.id }) },
        checkpoints: ofDay.map(b => ({ id: b.id, checkpoint: b.checkpoint, status: b.status, columns: b.columns, finished_at: b.finished_at, rows: b.counts?.graded ?? null, argus: !!b.argus })),
        day_list: withResults(dayList(ofDay), outcomes, { day: latest.day, closed, boardOf: (r, col) => r.cell_board?.[col] ?? r.board }),
        days,
        working,
        stats,
    }
}

/** The past days the Hotlist can step back to — a week name's result lands five sessions after its day. */
export const DAYS_KEPT = 20

// ─── Did it work? (Roy, 2026-10-24: "can we put some kind of signal to know if what the hotlist said is working") ───
//
// The outcome log (hotlist.outcomes) scores every graded cell once its window closes; until now it fed only the
// "unverified" note. Each graded column of a row now carries its RESULT — the board's own claim checked against the
// tape: `reached` the free-range level the grade was measured to, or `missed` it (with the best and the closing move);
// an open-sky cell has no level, so `up` or `down` by the window's return. Before that: `open` (the window is still
// running, until `ends`) or `scoring` (closed; the scoring pass runs after 18:00 ET). `no_data`: no bars came.

/** One cell's result. Pure. `doc` is its hotlist_outcomes row, or null; `closed` the last closed session. */
export function cellResult(doc, { day, column, closed }) {
    if (doc) {
        const o = doc.outcome
        if (!o) return { state: 'no_data' }
        const state = o.reached === true ? 'reached' : o.reached === false ? 'missed' : o.ret_pct > 0 ? 'up' : 'down'
        return { state, ret_pct: o.ret_pct ?? null, mfe_pct: o.mfe_pct ?? null, mae_pct: o.mae_pct ?? null, level: doc.level ?? null,
            entry: doc.entry ?? null, end: o.end ?? null, ...(o.partial ? { partial: true } : {}) }
    }
    const ends = windowEnd(day, column)
    return { state: ends > closed ? 'open' : 'scoring', ends }
}

/** Rows with `results: { column: cellResult }` for every graded column. Pure. `boardOf(row, column)` — the board the cell lives on. */
export function withResults(rows, outcomes, { day, closed, boardOf }) {
    const by = new Map((outcomes ?? []).map(o => [`${o.board}:${o.symbol}:${o.column}`, o]))
    return (rows ?? []).map(r => {
        const cols = Object.entries(r.cells ?? {}).filter(([, c]) => c?.grade).map(([col]) => col)
        if (!cols.length) return r
        return { ...r, results: Object.fromEntries(cols.map(col => [col, cellResult(by.get(`${boardOf(r, col)}:${r.symbol}:${col}`) ?? null, { day, column: col, closed })])) }
    })
}

async function _outcomesOf(db, q) {
    return db.collection(OUTCOMES).find(q, { projection: { _id: 0, board: 1, symbol: 1, column: 1, entry: 1, level: 1, outcome: 1 } }).toArray()
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
            // The single `pick` (what older readers read) follows the merged picks: this board's, else the best-ranked one
            // the name kept from an earlier board — never dropped while a column still carries one (code review 2026-10-24).
            const onePick = pick ?? Object.values(mergedPicks).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0] ?? null
            const merged = {
                ...rest,
                ...(onePick ? { pick: onePick } : {}),
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

/** One board for the Floor: boardById, each row with its results (withResults). */
export async function boardWithResults(id, deps = _deps) {
    const b = await boardById(id, deps)
    if (!b) return null
    const db = await deps.db()
    const outcomes = await _outcomesOf(db, { board: b.id })
    return { ...b, rows: withResults(b.rows, outcomes, { day: b.day, closed: lastClosedSession(deps.now()), boardOf: () => b.id }) }
}

/**
 * The outcome log summarised — per column and grade, and which columns are verified — and, under `argus`, Argus's
 * record: his picks, avoids and unmarked names by how often they ended up (hotlist.outcomes argusRecord).
 */
export async function hotlistOutcomes(deps = _deps) {
    const [summary, argus, backtest] = await Promise.all([deps.summary(), Promise.resolve(deps.argus?.()).catch(() => null),
        Promise.resolve(deps.backtest?.()).catch(() => null)])
    // `backtest` — the week replay over past sessions (hotlistBacktest.service), kept apart from the live record.
    return { ...summary, ...(argus ? { argus } : {}), ...(backtest ? { backtest } : {}) }
}

/** What a client sees of a board: no Mongo id, no claim bookkeeping. Pure. */
function _public(b) {
    // `wide` — the graded names past the board's cut — is the outcome log's, not the client's (hundreds of rows).
    const { _id, started_at, scored, requests, wide, ...rest } = b
    return rest
}
