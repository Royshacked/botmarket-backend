// THIS WEEK, OVERNIGHT — the run-up rule (docs/design/hotlist-day-archive.md §3; Roy, 2026-10-25: archive the day
// columns, rebuild This week on the one rule the screener lab kept — screener-lab.md §6–§7).
//
// THE RULE: bought at the next session's open 5 sessions before a company's report, out at the close before it;
// only when its last three reports all BEAT the estimate, and only while SPY is over its 200-day average. Over three
// years with the last held out it beat SPY by +0.39% a session after costs (before +0.37%, held out +0.45%) — modest,
// a FIXED DAILY BUDGET split across the day's names, not a ranking: every qualifying name is listed, equally.
//
// Built ONCE, after the nightly stats (dailyScreener.service runNightly), from what they carry — no live quote, no
// Argus (his blind replay picked no better than he avoided, screener-lab §9): the stats' `next_earnings` (the nightly
// calendar), one earnings-history read per name in the window (the streak), and SPY's 200-day from the run. Under the
// 200-day the board is written EMPTY with its reason, never left missing. The board is a `hotlist_boards` document
// like the checkpoint ones (`hb_<day>_week`, `checkpoint: 'overnight'`, `columns: ['week']`), so the read side, the
// outcome scoring (entry at the board day's OPEN) and Prometheus's catalyst reads take it as they take any board.
// Never throws.

import { getDb } from '../providers/mongodb.provider.js'
import { getEarningsRowsRaw } from '../providers/fmp.provider.js'
import { COLLECTION as STATS, latestRun } from './dailyScreener.service.js'
import { BOARDS, sessionsAfter } from './hotlist.outcomes.js'
import { createPacer } from './concurrency.util.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[hotlist.week]'
/** Sessions held: bought at the open of the first, out at the close of the fifth — the report falls on the sixth. */
export const HOLD = 5
/** The gates (the lab's): a price and a 20-day dollar volume, both as of the stats' close. */
export const MIN_PRICE = 5
export const MIN_ADV = 5e6
/** The streak: this many of the last reports, every one a beat. */
export const STREAK = 3
/** The week board's grade — one rule, so one grade: a name is on it or not. */
export const RUNUP_GRADE = 'R'
export const CHECKPOINT = 'overnight'
/** A board with failed reads is rebuilt at most this often (the reads are FMP's quota). */
export const RETRY_FAILED_MS = 60 * 60 * 1000
/** Boards older than this (calendar days) are deleted — the panel steps back 20 sessions (hotlist.service DAYS_KEPT). */
export const KEEP_DAYS = 30
const _addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
export const boardId = (day) => `hb_${day}_week`

const _deps = {
    db: () => getDb(),
    run: () => latestRun(),
    earnings: (symbol) => getEarningsRowsRaw(symbol, 12),
    perMinute: () => config.dailyScreenerRpm,
    now: () => Date.now(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
}
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * The window: a name whose next report falls after the close of the HOLD-th session from `boardDay` and no later
 * than the session after it — bought at `boardDay`'s open, out at that close, the report next (the lab's `runup(5)`:
 * `date[i+4] < report ≤ date[i+5]`). Weekdays; a holiday inside the week is not known here (the scoring stops at the
 * close before the report all the same). → the exit day (the HOLD-th session), or null. Pure.
 */
export function inWindow(boardDay, report) {
    if (!report) return null
    const exit = sessionsAfter(boardDay, HOLD - 1), after = sessionsAfter(boardDay, HOLD)
    return report > exit && report <= after ? exit : null
}

/**
 * The beat streak from a name's earnings rows (FMP `/earnings`, any order): the last STREAK reports BEFORE `day` with
 * an actual and an estimate → `{ beats, of, last: [{ date, actual, estimate }] }`. Pure.
 */
export function beatStreak(rows, day) {
    const past = (rows ?? []).filter(r => r?.date && r.date < day && r.epsActual != null && r.epsEstimated != null
        && Number.isFinite(Number(r.epsActual)) && Number.isFinite(Number(r.epsEstimated)))
        .sort((a, b) => b.date.localeCompare(a.date)).slice(0, STREAK)
    return { beats: past.filter(r => Number(r.epsActual) > Number(r.epsEstimated)).length, of: past.length,
        last: past.map(r => ({ date: r.date, actual: Number(r.epsActual), estimate: Number(r.epsEstimated) })) }
}

/** SPY over its 200-day as of the run, from the run document (`spy.over_sma200`) — null when the run does not say. Pure. */
export const marketOpen = (run) => (typeof run?.spy?.over_sma200 === 'boolean' ? run.spy.over_sma200 : null)

/** One qualifying name as a board row — the stats' facts, the report, the streak. Pure. */
export function weekRow(stats, report, exit, streak) {
    return {
        symbol: stats.symbol, name: stats.name ?? null, sector: stats.sector ?? null, industry: stats.industry ?? null,
        // The stats' close: what it was when listed. The trade's entry is the board day's OPEN (the outcome scoring).
        price: stats.close ?? null, atr_pct: stats.atr_pct ?? null, next_earnings: report, spark: stats.closes20 ?? null,
        status: 'setting_up',
        cells: { week: { grade: RUNUP_GRADE, path: 'scheduled', exit_before: report,
            why: [`reports ${report} — bought 5 sessions before, out at the close of ${exit}`, `the last ${streak.of} reports all beat`] } },
        streak: streak.last,
    }
}

/**
 * The board for `boardDay` from the run's stats → the `hotlist_boards` document. `streaks` Map(symbol → beatStreak).
 * Pure.
 */
export function buildWeekBoard({ boardDay, statsDay, stats, streaks, spyOver200, nowMs, calendarFailed = false }) {
    const base = { id: boardId(boardDay), day: boardDay, checkpoint: CHECKPOINT, columns: ['week'], stats_day: statsDay,
        status: 'done', finished_at: nowMs, rule: 'run-up: 5 sessions before the report, last 3 reports beat, SPY over its 200-day' }
    if (spyOver200 === false) return { ...base, market: { spy_over_sma200: false }, closed: 'SPY is under its 200-day — the run-up loses there, so no names', rows: [], counts: { window: 0, listed: 0 } }
    // The night's earnings calendar failed (dailyScreener.service `calendar_failed`): every report date is missing, and
    // an empty list would look like a quiet week — it says why instead (code review 2026-10-25).
    if (calendarFailed) return { ...base, market: { spy_over_sma200: spyOver200 }, closed: 'the earnings calendar could not be read tonight — no list (it is read again with the next run)', rows: [], counts: { window: 0, listed: 0 } }
    const window = [], rows = []
    for (const s of stats) {
        const exit = inWindow(boardDay, s.next_earnings)
        if (!exit || !(s.close >= MIN_PRICE) || !((s.adv20_usd ?? 0) >= MIN_ADV)) continue
        window.push(s.symbol)
        const st = streaks.get(s.symbol)
        if (!st || st.of < STREAK || st.beats < STREAK) continue
        rows.push(weekRow(s, s.next_earnings, exit, st))
    }
    rows.sort((a, b) => a.symbol.localeCompare(b.symbol))
    // A run from before the gate was computed says nothing about SPY: listed as open, and the board says so (bug hunt 2026-10-25).
    return { ...base, market: { spy_over_sma200: spyOver200, ...(spyOver200 == null ? { gate: 'unknown' } : {}) }, rows, counts: { window: window.length, listed: rows.length } }
}

let _active = false

/**
 * Build the next session's week board from the latest nightly run, once — again when it was built from a partial run
 * that is now done, or (at most hourly) when a name's earnings read failed (`force` always). A board with a failed read
 * is `partial`; boards past KEEP_DAYS are deleted.
 * → `{ ok, outcome, id?, listed?, failed? }`; outcome `no_run` · `exists` · `already_running` · `rate_limited` · `done` ·
 * `error`. Never throws.
 */
export async function runWeekBoard({ force = false, deps = _deps } = {}) {
    if (_active) return { ok: false, outcome: 'already_running' }
    _active = true
    try {
        const run = await deps.run()
        if (!run?.day) return { ok: false, outcome: 'no_run' }
        const boardDay = sessionsAfter(run.day, 1)
        const db = await deps.db()
        const boards = db.collection(BOARDS)
        // A board built from a PARTIAL run (rate-limited, names missing) is built again once the run is done; one whose
        // earnings reads failed, again at most hourly (code review 2026-10-25: a failed read had dropped the name for good).
        const have = force ? null : await boards.findOne({ id: boardId(boardDay) }, { projection: { _id: 0, stats_status: 1, counts: 1, finished_at: 1 } })
        if (have) {
            const failed = have.counts?.failed ?? 0
            const settled = have.stats_status === 'done' || run.status !== 'done'
            if (settled && (!failed || deps.now() - (have.finished_at ?? 0) < RETRY_FAILED_MS)) return { ok: true, outcome: 'exists', id: boardId(boardDay) }
        }

        const stats = await db.collection(STATS).find({ day: run.day }, { projection: { _id: 0, symbol: 1, name: 1, sector: 1, industry: 1, close: 1, atr_pct: 1, adv20_usd: 1, closes20: 1, next_earnings: 1 } }).toArray()
        const spyOver200 = marketOpen(run)
        // One history read per name in the window (~20–80 a night) — and none when the market gate is shut.
        const streaks = new Map()
        let failed = 0
        if (spyOver200 !== false && !run.calendar_failed) {
            const pace = createPacer({ perMinute: deps.perMinute(), now: deps.now, sleep: deps.sleep })
            for (const s of stats) {
                if (!inWindow(boardDay, s.next_earnings) || !(s.close >= MIN_PRICE) || !((s.adv20_usd ?? 0) >= MIN_ADV)) continue
                await pace()
                try { streaks.set(s.symbol, beatStreak(await deps.earnings(s.symbol), boardDay)) } catch (err) {
                    if (err?.status === 429) { logger.warn(LOG, `${boardDay}: rate-limited at ${s.symbol} — retried next tick`); return { ok: false, outcome: 'rate_limited' } }
                    failed++
                }
            }
        }
        const built = buildWeekBoard({ boardDay, statsDay: run.day, stats, streaks, spyOver200, nowMs: deps.now(), calendarFailed: Boolean(run.calendar_failed) })
        const board = { ...built, stats_status: run.status, status: failed ? 'partial' : built.status, counts: { ...built.counts, failed } }
        await boards.updateOne({ id: board.id }, { $set: board }, { upsert: true })
        // The boards' retention (the archived checkpoint pass kept 10 days; this one keeps the panel's 20 sessions).
        await boards.deleteMany({ day: { $lt: _addDays(boardDay, -KEEP_DAYS) } })
        logger.info(LOG, `${board.id}: ${board.rows.length} names of ${board.counts.window} in the window${failed ? `, ${failed} earnings reads failed` : ''}${board.closed ? ` — ${board.closed}` : ''}`)
        return { ok: true, outcome: 'done', id: board.id, listed: board.rows.length, ...(failed ? { failed } : {}) }
    } catch (err) {
        logger.warn(LOG, `week board not built: ${err.message}`)
        return { ok: false, outcome: 'error', detail: err.message }
    } finally {
        _active = false
    }
}

