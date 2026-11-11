// The DAY BOARDS — revived 2026-11-11 from the archived checkpoint pass (archive/services/dailyScreener.checkpoint.js;
// docs/design/argus-rework.md §3.3, step 2), cut to what the replay did not refute: they say which names WILL MOVE, not
// which way.
//
//   open  09:20 ET  the extended book, the open column's gates and in-play rule
//   mid   10:30 ET  the session's quotes, mid-session's
//   eod   14:30 ET  the session's quotes, into the close
//
// BACK: the POOL (earnings reported since the last close, today's rating changes, fresh news, the movers in session,
// the overnight structures), the column's HARD GATES (hotlist.columns failedGate — price, dollar volume, ATR, spread) and
// the IN-PLAY numbers (relative volume, the gap, where it sits in the day's range, a fresh catalyst BY TIMESTAMP).
// NOT BACK (Roy, 2026-11-11): the A/B/C grades and the free range they were measured on, the ranking by them, the news
// labeller's model call (a catalyst is its headlines and their times), Argus's blind read of each board, the wide set and
// the outcome log. 08:00 (a duplicate of the open) and 15:30 (an overnight hold) stay archived.
//
// OWN COLLECTION (Roy, 2026-11-11): `hotlist_day_boards`, never `hotlist_boards` — the Hotlist's read side merges every
// board of a day into This week's `day_list`, which Argus, Axl and the Floor read as the run-up list.
//
// Same switch as the overnight pass (DAILY_SCREENER), same pace (DAILY_SCREENER_RPM), same rule on a 429: waited out a
// few times, then the board stops and publishes what it has, marked partial. Driven by the screener's monitor tick.

import { getDb } from '../providers/mongodb.provider.js'
import { fetchStockNews, getEarningsCalendarRaw, latestGradesRaw, marketMoversRaw } from '../providers/fmp.provider.js'
import { getFmpQuoteFull, getAftermarketQuote, fmpDateToEpochSec } from '../providers/fmp.price.provider.js'
import { createPacer } from './concurrency.util.js'
import { failedGate, inPlay, relativeVolume, weekSetup } from './hotlist.columns.js'
import { COLLECTION as STATS, latestRun, claimRun } from './dailyScreener.service.js'
import { etNow, etDate } from './hotlist.boards.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[hotlist.day]'

export const DAY_BOARDS = 'hotlist_day_boards'

/** The three boards (ET minutes). `book`: the extended-hours book before the open, the session's after. */
export const CHECKPOINTS = Object.freeze([
    { id: 'open', etMin: 9 * 60 + 20,  column: 'open', book: 'extended', label: '09:20' },
    { id: 'mid',  etMin: 10 * 60 + 30, column: 'mid',  book: 'session',  label: '10:30' },
    { id: 'eod',  etMin: 14 * 60 + 30, column: 'eod',  book: 'session',  label: '14:30' },
])
/** A checkpoint missed by more than this is skipped, not run late — a 10:30 board at 13:00 is wrong. */
export const WINDOW_MIN = 30
export const POOL_MAX = 300
/** The names a board shows. */
export const BOARD_MAX = 60
/** The latest headlines kept per name — the catalyst is these and their times. */
export const NEWS_PER_NAME = 3
export const RETRY_429 = 3
export const RETRY_429_BUDGET = 15
const RETRY_429_MS = 20_000
const KEEP_DAYS = 10
const NEWS_CHUNK = 50
/** A `running` board older than this is a dead process's. */
export const STALE_MS = 60 * 60 * 1000
/** An errored board is tried this many times in its window, then left. */
export const MAX_ATTEMPTS = 3
const OPEN_MIN = 9 * 60 + 30, SESSION_MIN = 390
const STRUCTURE_MAX = 60

export const boardId = (day, checkpoint) => `hd_${day}_${checkpoint}`

const _deps = {
    db:        () => getDb(),
    latestRun: () => latestRun(),
    news:      (symbols, from, to) => fetchStockNews({ symbols, from, to, limit: 250 }),
    earnings:  (from, to, symbols) => getEarningsCalendarRaw(from, to, symbols),
    grades:    () => latestGradesRaw(),
    movers:    (kind) => marketMoversRaw(kind),
    extQuote:  (symbol) => getAftermarketQuote(symbol),
    quote:     (symbol) => getFmpQuoteFull(symbol, { fresh: true }),
    perMinute: () => config.dailyScreenerRpm,
    now:       () => Date.now(),
    sleep:     (ms) => new Promise(r => setTimeout(r, ms)),
}
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

export async function ensureDayBoardIndexes() {
    const db = await _deps.db()
    await db.collection(DAY_BOARDS).createIndex({ id: 1 }, { unique: true })
    await db.collection(DAY_BOARDS).createIndex({ day: 1 })
}

/** The checkpoint whose window `nowMs` falls in, with the ET session date — or null (outside, or a weekend). Pure. */
export function dueCheckpoint(nowMs) {
    const now = etNow(nowMs)
    if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(now.weekday)) return null
    const cp = CHECKPOINTS.find(c => now.min >= c.etMin && now.min < c.etMin + WINDOW_MIN)
    return cp ? { checkpoint: cp, day: now.date, etMin: now.min } : null
}

/**
 * The pool's sources folded into one ordered list. Pure. Only names in `eligible` (the column's stats gates) survive;
 * capped at `max`. Order: earnings reported → rating changes → news (most headlines first) → movers → structures.
 */
export function buildPool({ earnings, grades, news, movers, structure }, eligible, max = POOL_MAX) {
    const out = []
    const seen = new Set()
    for (const src of [earnings, grades, news, movers, structure]) {
        for (const s of src ?? []) {
            const sym = String(s).toUpperCase()
            if (seen.has(sym) || !eligible.has(sym)) continue
            seen.add(sym)
            out.push(sym)
            if (out.length >= max) return out
        }
    }
    return out
}

/**
 * The overnight list's best structures (RS + NR7 / an inside day / near the 20-day high), strongest RS first — in session
 * a strong base can come into play on the tape alone. A report within a day is left out. Pure.
 */
export function structureNames(statsList, today, max = STRUCTURE_MAX) {
    return (statsList ?? [])
        .filter(s => { const w = weekSetup(s, today); return w.base && !w.binary })
        .sort((a, b) => (b.rs20 ?? 0) - (a.rs20 ?? 0))
        .slice(0, max)
        .map(s => s.symbol)
}

/** The names the column could put on a board at all: its stats gates (price, dollar volume, ATR). Pure. */
export function eligibleNames(statsList, column) {
    return new Set((statsList ?? []).filter(s => !failedGate(column, s)).map(s => s.symbol))
}

/**
 * A name's catalyst BY TIMESTAMP — its latest headlines since the last close (newest first, NEWS_PER_NAME), and whether
 * it reported or had a rating change since then. Null when none of the three. Pure.
 */
export function catalystOf(symbol, { headlines, reported, rated }) {
    const news = [...(headlines?.get(symbol) ?? [])].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, NEWS_PER_NAME)
    const earnings = reported?.has(symbol) ?? false
    const rating = rated?.has(symbol) ?? false
    if (!news.length && !earnings && !rating) return null
    return { news, earnings, rating }
}

const _r = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)

/**
 * One name on a board, or null when it fails the column's gates or is not in play. Pure.
 *
 * The in-play rule is the column's (hotlist.columns inPlay). Its "fresh news" path asked the archived labeller whether a
 * story was MATERIAL; with no labeller, a fresh catalyst by timestamp — a headline, a report or a rating change since the
 * last close — stands in for it.
 */
export function boardRow(stats, q, column, { book, etMin, day, catalyst = null, quotedAt = null }) {
    if (!stats || !q) return null
    const extended = book === 'extended'
    const prevClose = extended ? stats.close : (q.previousClose ?? stats.close)
    const ctx = extended
        ? { price: q.mid, prevClose, spreadPct: q.spreadPct, pmVolPct: stats.avg_vol20 > 0 && q.volume != null ? (q.volume / stats.avg_vol20) * 100 : null }
        : { price: q.price, prevClose, open: q.open, dayHigh: q.dayHigh, dayLow: q.dayLow,
            rvol: relativeVolume(q.volume, stats.avg_vol20, (etMin - OPEN_MIN) / SESSION_MIN) }
    if (failedGate(column, stats, ctx)) return null
    const play = inPlay(column, stats, { ...ctx, catalyst: catalyst ? { material: true } : null, today: day })
    if (!play.in) return null
    const gap = ctx.price > 0 && prevClose > 0 ? ((ctx.price - prevClose) / prevClose) * 100 : null
    const hi = Number(ctx.dayHigh), lo = Number(ctx.dayLow)
    const rangePos = hi > lo && ctx.price != null ? (ctx.price - lo) / (hi - lo) : null
    return {
        symbol: stats.symbol, name: stats.name ?? null, sector: stats.sector ?? null,
        price: _r(ctx.price, 4), gap_pct: _r(gap), rvol: ctx.rvol ?? null,
        pm_vol_pct: _r(ctx.pmVolPct), spread_pct: _r(ctx.spreadPct, 3),
        range_pos: _r(rangePos),
        atr_pct: stats.atr_pct ?? null, next_earnings: stats.next_earnings ?? null,
        spark: Array.isArray(stats.closes20) && stats.closes20.length >= 2 ? stats.closes20 : null,
        quoted_at: quotedAt,
        why: play.why,
        catalyst,
    }
}

/**
 * The board's order — NOT a grade (none came back): a fresh catalyst first, then the biggest move either way, then volume
 * against an ordinary day. Pure.
 */
export function orderRows(rows) {
    const vol = (r) => r.rvol ?? (Number.isFinite(r.pm_vol_pct) ? r.pm_vol_pct / 10 : 0)
    return [...(rows ?? [])].filter(Boolean)
        .sort((a, b) => (b.catalyst ? 1 : 0) - (a.catalyst ? 1 : 0)
            || Math.abs(b.gap_pct ?? 0) - Math.abs(a.gap_pct ?? 0) || vol(b) - vol(a) || a.symbol.localeCompare(b.symbol))
}

let _active = false

/**
 * Run the board that is due, unless it exists. → `{ ok, outcome, id?, rows?, counts? }`; outcome one of `not_due` ·
 * `exists` · `already_running` · `no_stats` · `done` · `partial` · `error` · `gave_up` (errored MAX_ATTEMPTS times). Never
 * throws.
 */
export async function runDayBoard({ deps = _deps } = {}) {
    if (_active) return { ok: false, outcome: 'already_running' }
    const due = dueCheckpoint(deps.now())
    if (!due) return { ok: false, outcome: 'not_due' }
    _active = true
    let claimed = null
    try {
        const { checkpoint: cp, day, etMin } = due
        const id = boardId(day, cp.id)
        const db = await deps.db()
        const boards = db.collection(DAY_BOARDS)
        const prior = await boards.findOne({ id })
        // A board that ERRORED is retried in its window (CR 2026-11-11: left `running`, it blocked the window past its end)
        // — up to MAX_ATTEMPTS, so a build that keeps failing does not spend the key every tick.
        if (prior?.status === 'error' && (prior.attempts ?? 0) >= MAX_ATTEMPTS) return { ok: false, outcome: 'gave_up', id }
        if (prior && !['running', 'error'].includes(prior.status)) return { ok: true, outcome: 'exists', id }
        if (prior?.status === 'running' && deps.now() - (prior.started_at ?? 0) < STALE_MS) return { ok: false, outcome: 'already_running', id }

        const run = await deps.latestRun()
        if (!run?.day) return { ok: false, outcome: 'no_stats', id }
        // Claimed atomically (the overnight pass's claim): two servers on one window build one board.
        if (!(await claimRun(boards, id, { day, checkpoint: cp.id }, prior, deps.now()))) return { ok: false, outcome: 'already_running', id }
        claimed = { boards, id }

        const board = await _build(db, cp, day, etMin, run, deps)
        await boards.updateOne({ id }, { $set: { ...board, finished_at: deps.now() } })
        await boards.deleteMany({ day: { $lt: _daysBefore(day, KEEP_DAYS) } })
        logger.info(LOG, `${id}: ${board.status} — ${board.rows.length} in play from a pool of ${board.counts.pool}${board.stopped ? `, stopped: ${board.stopped}` : ''}`)
        return { ok: board.status === 'done', outcome: board.status, id, rows: board.rows.length, counts: board.counts }
    } catch (err) {
        logger.error(LOG, 'day board failed:', err.message)
        // A claimed board is marked `error`, not left `running`, so the next tick in the window can take it again.
        if (claimed) await claimed.boards.updateOne({ id: claimed.id }, { $set: { status: 'error', error: err.message, finished_at: deps.now() } }).catch(() => null)
        return { ok: false, outcome: 'error', detail: err.message }
    } finally {
        _active = false
    }
}

const _daysBefore = (day, n) => new Date(Date.parse(day) - n * 86_400_000).toISOString().slice(0, 10)

async function _build(db, cp, day, etMin, run, deps) {
    const statsList = await db.collection(STATS).find({ day: run.day }).toArray()
    const byStats = new Map(statsList.map(s => [s.symbol, s]))
    const pace = createPacer({ perMinute: deps.perMinute(), now: deps.now, sleep: deps.sleep })
    let requests = 0, stopped = null, retried429 = 0
    // A 429 is waited out before it stops the board: in session the key is shared with live pricing, so a brief spike
    // over the limit is ordinary (2026-10-22: the 10:30 board stopped at its 9th quote). Only a limit that outlasts every
    // retry rethrows, and the board goes out partial.
    const paced = async (fn) => {
        for (let attempt = 0; ; attempt++) {
            await pace(); requests++
            try { return await fn() } catch (err) {
                if (err?.status !== 429 || attempt >= RETRY_429 || retried429 >= RETRY_429_BUDGET) throw err
                retried429++
                await deps.sleep(RETRY_429_MS)
            }
        }
    }
    const stop429 = (err) => { if (err?.status === 429) stopped = 'rate_limited' }

    // ── The pool. Fresh = after the overnight run's session closed (16:00 ET on run.day). ──
    const sinceSec = (fmpDateToEpochSec(`${run.day} 16:00:00`) ?? 0)
    const headlines = new Map()
    const universe = statsList.map(s => s.symbol)
    for (let i = 0; i < universe.length && !stopped; i += NEWS_CHUNK) {
        try {
            const rows = await paced(() => deps.news(universe.slice(i, i + NEWS_CHUNK), run.day, day))
            for (const n of rows ?? []) {
                const sym = String(n?.symbol ?? '').toUpperCase()
                if (!byStats.has(sym) || (fmpDateToEpochSec(n.publishedDate) ?? 0) <= sinceSec) continue
                if (!headlines.has(sym)) headlines.set(sym, [])
                const list = headlines.get(sym)
                if (!list.some(h => h.title === n.title)) list.push({ title: n.title, at: n.publishedDate })
            }
        } catch (err) { stop429(err) }
    }
    const reported = new Set()
    if (!stopped) {
        try {
            for (const e of await paced(() => deps.earnings(run.day, day, universe)) ?? []) {
                if (e?.date && e.date >= run.day && e.date <= day) reported.add(String(e.symbol).toUpperCase())
            }
        } catch (err) { stop429(err) }
    }
    const rated = new Set()
    if (!stopped) {
        try {
            for (const g of await paced(() => deps.grades()) ?? []) {
                if ((Date.parse(g?.publishedDate) / 1000) > sinceSec) rated.add(String(g.symbol).toUpperCase())
            }
        } catch (err) { stop429(err) }
    }
    const moving = new Set()
    if (!stopped && cp.book === 'session') {
        for (const kind of ['gainers', 'active']) {
            try { for (const m of await paced(() => deps.movers(kind)) ?? []) moving.add(String(m.symbol).toUpperCase()) }
            catch (err) { stop429(err); if (stopped) break }
        }
    }
    const news = [...headlines].sort((a, b) => b[1].length - a[1].length).map(([s]) => s)
    const pool = buildPool({ earnings: reported, grades: rated, news, movers: moving, structure: structureNames(statsList, day) },
        eligibleNames(statsList, cp.column))

    // ── Quotes ──
    const rows = []
    let quoted = 0
    for (const sym of pool) {
        if (stopped) break
        try {
            const q = await paced(() => (cp.book === 'extended' ? deps.extQuote(sym) : deps.quote(sym)))
            if (!q) continue
            quoted++
            const catalyst = catalystOf(sym, { headlines, reported, rated })
            const row = boardRow(byStats.get(sym), q, cp.column, { book: cp.book, etMin, day, catalyst, quotedAt: deps.now() })
            if (row) rows.push(row)
        } catch (err) { stop429(err) }
    }

    const ordered = orderRows(rows)
    return {
        day, checkpoint: cp.id, column: cp.column, book: cp.book,
        status: stopped ? 'partial' : 'done',
        stopped,
        stats_day: run.day,
        regime: { breadth_above_sma20: run.breadth_above_sma20 ?? null, spy: run.spy ?? null },
        counts: { pool: pool.length, quoted, in_play: rows.length, headlines: headlines.size },
        requests,
        retried_429: retried429,
        rows: ordered.slice(0, BOARD_MAX),
    }
}

// ─── The read side ───────────────────────────────────────────────────────────

/** What a client sees of a board: no Mongo id, no claim bookkeeping. Pure. */
export function publicBoard(b) {
    if (!b) return null
    const { _id, started_at, attempts, requests, ...rest } = b
    return rest
}

const DONE = { status: { $in: ['done', 'partial'] } }

/**
 * A day's boards, oldest checkpoint first, and the days there are boards for (newest first). `day` defaults to the
 * latest day with a board. → `{ day, boards, days }`.
 */
export async function dayBoards({ day = null, deps = _deps } = {}) {
    const db = await deps.db()
    const coll = db.collection(DAY_BOARDS)
    const recent = await coll.find(DONE, { projection: { _id: 0, day: 1 } }).sort({ day: -1 }).limit(KEEP_DAYS * CHECKPOINTS.length).toArray()
    const days = [...new Set(recent.map(b => b.day).filter(Boolean))]
    const which = day ?? days[0] ?? null
    if (!which) return { day: null, boards: [], days }
    const boards = await coll.find({ ...DONE, day: which }).sort({ finished_at: 1 }).toArray()
    return { day: which, boards: boards.map(publicBoard), days }
}

/** Today's boards (ET), newest first — Argus's intraday list and the pick gate's second look. */
export async function todayBoards({ deps = _deps } = {}) {
    const db = await deps.db()
    const boards = await db.collection(DAY_BOARDS).find({ ...DONE, day: etDate(deps.now()) }).sort({ finished_at: -1 }).toArray()
    return boards.map(publicBoard)
}

/** The next board's time today in ET words, or null after the last one. Pure. */
export function nextCheckpoint(nowMs) {
    const now = etNow(nowMs)
    if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(now.weekday)) return null
    return CHECKPOINTS.find(c => now.min < c.etMin + WINDOW_MIN)?.label ?? null
}
