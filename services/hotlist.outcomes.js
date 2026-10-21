// The hotlist's OUTCOME LOG (docs/design/daily-names.md §7, build phase 4) — what every graded cell
// actually did afterwards. The board's grades are "unverified" until this has enough history per
// column to say whether an A beats a C at all; this is that history.
//
// One document per (board, symbol, column) in `hotlist_outcomes`, measured LONG from the board's
// price over the column's own window:
//   open      the session's first hour (the 09:30 hourly bar)
//   mid       10:30 → the close      (hourly bars)
//   eod       14:30 → the close      (hourly bars)
//   tomorrow  the next session        (its daily bar)
//   week      five sessions from the board's day (daily bars)
// Measured: the best and worst excursion (MFE / MAE, %), the return at the window's end, and whether
// price REACHED the free-range level the grade was measured to (null for open sky).
//
// Scoring runs off-session (after 16:30 ET, before 08:00, weekends), at most once an hour, paced,
// and stops on a 429 like the other passes. A window still missing its bars a few sessions after it
// should have closed (a holiday, a halted name) is marked scored with no outcome rather than retried
// forever. Same switch as the passes: DAILY_SCREENER.

import { getDb } from '../providers/mongodb.provider.js'
import { getFmpCandles } from '../providers/fmp.price.provider.js'
import { createPacer } from './concurrency.util.js'
import { COLUMNS } from './hotlist.columns.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[hotlist.outcomes]'

export const OUTCOMES = 'hotlist_outcomes'
/** The checkpoint boards (written by dailyScreener.checkpoint). Named here so that module can read this one's
 *  summary without an import cycle. */
export const BOARDS = 'hotlist_boards'

/** Sessions the week column is measured over. */
export const WEEK_SESSIONS = 5
/** Boards older than this are not scored any more (their windows are long closed). */
const LOOKBACK_DAYS = 21
/** A window still without bars this many sessions after it should have closed is given up on. */
const GIVE_UP_SESSIONS = 3
/** At most one scoring run an hour — the monitor ticks every five minutes. */
const MIN_GAP_MS = 60 * 60 * 1000

/** §7's bar for a column to stop being "unverified": this much history, and this many samples. */
export const VERIFY_MIN_SESSIONS = 40
export const VERIFY_MIN_SAMPLES  = 30

const _deps = {
    db:        () => getDb(),
    hourly:    (symbol, day) => getFmpCandles(symbol, { timeSpan: 'hour', multiplier: 1, from: Date.parse(day), to: Date.parse(day) }),
    daily:     (symbol, from, to) => getFmpCandles(symbol, { timeSpan: 'day', multiplier: 1, from: Date.parse(from), to: Date.parse(to) }),
    perMinute: () => config.dailyScreenerRpm,
    now:       () => Date.now(),
    sleep:     (ms) => new Promise(r => setTimeout(r, ms)),
}
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

export async function ensureHotlistOutcomeIndexes() {
    const db = await _deps.db()
    await db.collection(OUTCOMES).createIndex({ id: 1 }, { unique: true })
    await db.collection(OUTCOMES).createIndex({ column: 1, day: 1 })
}

// ─── ET calendar (pure) ───────────────────────────────────────────────────────

const _ET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
function _et(ms) {
    const p = Object.fromEntries(_ET.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
    return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, min: Number(p.hour) * 60 + Number(p.minute) }
}
const _isWeekday = (date) => { const d = new Date(`${date}T12:00:00Z`).getUTCDay(); return d >= 1 && d <= 5 }
const _addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** The weekday `n` sessions after `date` (n = 0 → `date` itself). Holidays are not known. Pure. */
export function sessionsAfter(date, n) {
    let d = date, left = n
    while (left > 0) { d = _addDays(d, 1); if (_isWeekday(d)) left-- }
    return d
}

/** The last session a column's window covers, for a board of `day`. Pure. */
export function windowEnd(day, column) {
    if (column === 'tomorrow') return sessionsAfter(day, 1)
    if (column === 'week')     return sessionsAfter(day, WEEK_SESSIONS - 1)
    return day
}

/** The latest ET session date whose close is in (after 16:30 ET on a weekday → today). Pure. */
export function lastClosedSession(nowMs) {
    const now = _et(nowMs)
    if (_isWeekday(now.date) && now.min >= 16 * 60 + 30) return now.date
    let d = _addDays(now.date, -1)
    while (!_isWeekday(d)) d = _addDays(d, -1)
    return d
}

/** Off-session: when scoring may run without competing with the checkpoints for the quota. Pure. */
export function scoringWindow(nowMs) {
    const now = _et(nowMs)
    return !_isWeekday(now.date) || now.min >= 16 * 60 + 30 || now.min < 8 * 60
}

const _etDateOf = (tsSec) => _et(tsSec * 1000).date
const _etMinOf  = (tsSec) => _et(tsSec * 1000).min

// ─── Scoring one cell (pure) ──────────────────────────────────────────────────

/** The bars a column's window covers, from the name's hourly bars of `day` and its daily bars. Pure. */
export function windowBars(column, day, { hourly = [], daily = [] } = {}) {
    const ofDay = hourly.filter(b => _etDateOf(b.timestamp) === day)
    switch (column) {
    case 'open': return ofDay.filter(b => _etMinOf(b.timestamp) === 9 * 60 + 30)
    case 'mid':  return ofDay.filter(b => _etMinOf(b.timestamp) >= 10 * 60 + 30)
    case 'eod':  return ofDay.filter(b => _etMinOf(b.timestamp) >= 14 * 60 + 30)
    case 'tomorrow': {
        const next = daily.find(b => _etDateOf(b.timestamp) > day)
        return next ? [next] : []
    }
    case 'week': return daily.filter(b => _etDateOf(b.timestamp) >= day).slice(0, WEEK_SESSIONS)
    default: return []
    }
}

const _r = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)

/**
 * What a cell did over its window, long from `entry`. Null when the window has no bars. Pure.
 *
 * @param {{ entry: number, level: ?number }} cell
 * @param {object[]} bars  the window's bars (windowBars)
 * @param {number} [expected]  how many bars a complete window holds (week: 5) — fewer is `partial`
 */
export function scoreWindow({ entry, level }, bars, expected = null) {
    if (!(entry > 0) || !bars?.length) return null
    const hi = Math.max(...bars.map(b => b.high))
    const lo = Math.min(...bars.map(b => b.low))
    const last = bars.at(-1)
    return {
        mfe_pct:  _r((hi / entry - 1) * 100),
        mae_pct:  _r((lo / entry - 1) * 100),
        ret_pct:  _r((last.close / entry - 1) * 100),
        reached:  level > 0 ? hi >= level : null,
        bars:     bars.length,
        ...(expected != null && bars.length < expected ? { partial: true } : {}),
        end:      _etDateOf(last.timestamp),
    }
}

// ─── The summary (pure) ───────────────────────────────────────────────────────

const _median = (xs) => {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
    if (!s.length) return null
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * The log → per column, per grade: samples, the share that REACHED their level, the median best
 * move and the mean return; per column: samples and how many sessions it spans. Pure.
 */
export function summarize(outcomes) {
    const out = {}
    for (const col of COLUMNS) {
        const rows = outcomes.filter(o => o.column === col && o.outcome)
        const days = new Set(rows.map(o => o.day))
        const byGrade = {}
        for (const g of ['A', 'B', 'C']) {
            const gr = rows.filter(o => o.grade === g)
            const judged = gr.filter(o => o.outcome.reached != null)
            byGrade[g] = {
                n: gr.length,
                hit_rate:   judged.length ? _r((judged.filter(o => o.outcome.reached).length / judged.length) * 100, 1) : null,
                mfe_median: _r(_median(gr.map(o => o.outcome.mfe_pct))),
                ret_mean:   gr.length ? _r(gr.reduce((s, o) => s + (o.outcome.ret_pct ?? 0), 0) / gr.length) : null,
            }
        }
        out[col] = { n: rows.length, sessions: days.size, grades: byGrade, verified: columnVerified({ n: rows.length, sessions: days.size }) }
    }
    return out
}

/** §7: a column is verified once it has VERIFY_MIN_SESSIONS of history and VERIFY_MIN_SAMPLES. Pure. */
export function columnVerified({ n, sessions }) {
    return n >= VERIFY_MIN_SAMPLES && sessions >= VERIFY_MIN_SESSIONS
}

// ─── The run ──────────────────────────────────────────────────────────────────

let _active = false
let _lastRunAt = 0

/**
 * Score every board cell whose window has closed and is not scored yet. → `{ ok, outcome, scored?,
 * gave_up?, stopped? }`; outcome one of `not_due` · `already_running` · `nothing_due` · `done` ·
 * `partial` · `error`. Never throws.
 */
export async function runOutcomes({ force = false, deps = _deps } = {}) {
    const nowMs = deps.now()
    if (!force && (!scoringWindow(nowMs) || nowMs - _lastRunAt < MIN_GAP_MS)) return { ok: false, outcome: 'not_due' }
    if (_active) return { ok: false, outcome: 'already_running' }
    _active = true
    _lastRunAt = nowMs
    try {
        const db = await deps.db()
        const closed = lastClosedSession(nowMs)
        const cutoff = _addDays(closed, -LOOKBACK_DAYS)
        const boards = await db.collection(BOARDS).find({ status: { $in: ['done', 'partial'] }, day: { $gt: cutoff } }).toArray()

        // Every (board, column) whose window has closed and is not scored yet.
        const due = []
        for (const b of boards) {
            for (const col of b.columns ?? []) {
                if (b.scored?.[col]) continue
                if (windowEnd(b.day, col) > closed) continue
                due.push({ board: b, column: col })
            }
        }
        if (!due.length) return { ok: true, outcome: 'nothing_due' }

        const pace = createPacer({ perMinute: deps.perMinute(), now: deps.now, sleep: deps.sleep })
        const hourlyCache = new Map(), dailyCache = new Map()
        let stopped = null, scored = 0, gaveUp = 0
        const fetchOnce = async (cache, key, fn) => {
            if (cache.has(key)) return cache.get(key)
            await pace()
            const v = await fn()
            cache.set(key, v ?? [])
            return v ?? []
        }

        for (const { board, column } of due) {
            if (stopped) break
            const intraday = ['open', 'mid', 'eod'].includes(column)
            const docs = []
            try {
                for (const row of board.rows ?? []) {
                    const c = row.cells?.[column]
                    if (!c?.grade) continue
                    const bars = intraday
                        ? { hourly: await fetchOnce(hourlyCache, `${row.symbol}|${board.day}`, () => deps.hourly(row.symbol, board.day)) }
                        : { daily: await fetchOnce(dailyCache, `${row.symbol}|${board.day}`, () => deps.daily(row.symbol, board.day, sessionsAfter(board.day, WEEK_SESSIONS + 2))) }
                    const win = windowBars(column, board.day, bars)
                    const outcome = scoreWindow({ entry: row.price, level: c.range?.level ?? null }, win, column === 'week' ? WEEK_SESSIONS : null)
                    docs.push({
                        id: `${board.id}:${row.symbol}:${column}`, board: board.id, day: board.day, checkpoint: board.checkpoint,
                        column, symbol: row.symbol, grade: c.grade, entry: row.price,
                        level: c.range?.level ?? null, atr_mult: c.range?.atr_mult ?? null, open_sky: c.range?.open_sky ?? false,
                        outcome, scored_at: deps.now(),
                    })
                }
            } catch (err) {
                if (err?.status === 429) { stopped = 'rate_limited'; break }
                logger.warn(LOG, `${board.id} ${column}: ${err.message}`)
                continue
            }

            // A window whose bars are not there yet is retried — unless it closed long enough ago that
            // they are never coming (a holiday, a halted name): then it is scored with no outcome.
            const missing = docs.some(d => !d.outcome)
            const stale = sessionsAfter(windowEnd(board.day, column), GIVE_UP_SESSIONS) <= closed
            if (missing && !stale) continue
            if (missing) gaveUp += docs.filter(d => !d.outcome).length

            if (docs.length) {
                await db.collection(OUTCOMES).bulkWrite(
                    docs.map(d => ({ updateOne: { filter: { id: d.id }, update: { $set: d }, upsert: true } })), { ordered: false })
            }
            await db.collection(BOARDS).updateOne({ id: board.id }, { $set: { [`scored.${column}`]: true } })
            scored += docs.length
        }

        logger.info(LOG, `scored ${scored} cell(s)${gaveUp ? `, ${gaveUp} without bars` : ''}${stopped ? `, stopped: ${stopped}` : ''}`)
        return { ok: !stopped, outcome: stopped ? 'partial' : 'done', scored, gave_up: gaveUp, stopped }
    } catch (err) {
        logger.error(LOG, 'scoring failed:', err.message)
        return { ok: false, outcome: 'error', detail: err.message }
    } finally {
        _active = false
    }
}

/** The whole log, summarised (summarize) — for the board's `verified` stamp and the Floor. */
export async function outcomeSummary(deps = _deps) {
    const db = await deps.db()
    const rows = await db.collection(OUTCOMES).find({}, { projection: { column: 1, day: 1, grade: 1, outcome: 1 } }).toArray()
    return summarize(rows)
}

/** Every board of a day, oldest checkpoint first — the Floor's Hotlist history (phase 6). */
export async function boardsForDay(day, deps = _deps) {
    const db = await deps.db()
    return db.collection(BOARDS).find({ day, status: { $in: ['done', 'partial'] } }).sort({ started_at: 1 }).toArray()
}
