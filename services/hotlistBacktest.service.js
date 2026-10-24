// THE WEEK REPLAY — the Hotlist's This week grades run over past sessions (Roy, 2026-10-24: "can't we score
// retrospectively?"). The live record grows a few names a day; this answers "does an A beat a C" now.
//
// THE SAME RULES, NOT A COPY. Each past session D, for each name in today's universe: the overnight stats as the pass
// would have computed them the evening before (dailyScreener.stats screenerStats, on the bars before D), the next report
// as the pass would have read it (first date on or after D−1, within its 21 days), the price = D's OPEN (the 09:20
// quote's stand-in), then the live week cell (hotlist.columns cell: gates, in play, free range, grade) and the live
// five-session window and score (hotlist.outcomes windowBars / scoreWindow). A name that clears the week's gates but
// grades nothing is the POOL — the control group. No lookahead: the stats and the level are from bars before D.
//
// WHAT IT CANNOT REPLAY, said wherever it is shown: the "drift" path (a material story that morning — no news labels
// for the past), so only the scheduled-report and money-arriving paths; and survivorship — today's universe, so names
// that delisted or fell under $5 since are missing. It is kept APART from the live record (`hotlist_backtest`, one
// summary document) and never counts toward "verified".
//
// Cost: one daily-bars read per name (~1,200) and a few earnings-calendar reads, paced at DAILY_SCREENER_RPM — run it
// off-session (scripts/replay-hotlist-week.mjs). Only the totals are stored.

import { getDb } from '../providers/mongodb.provider.js'
import { getFmpCandles } from '../providers/fmp.price.provider.js'
import { getEarningsCalendarRaw } from '../providers/fmp.provider.js'
import { screenerStats } from './dailyScreener.stats.js'
import { COLLECTION as STATS } from './dailyScreener.service.js'
import { cell, failedGate } from './hotlist.columns.js'
import { windowBars, windowPartial, scoreWindow, WEEK_SESSIONS, POOL_GRADE } from './hotlist.outcomes.js'
import { createPacer } from './concurrency.util.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[hotlistBacktest]'
export const BACKTEST = 'hotlist_backtest'
/** Sessions replayed by default — about six months. */
export const REPLAY_SESSIONS = 125
/** History before the first replayed session: the stats' 52-week high wants a year of bars. */
const HISTORY_DAYS = 400
/** The overnight pass's earnings window (dailyScreener.service EARNINGS_DAYS). */
const EARNINGS_DAYS = 21
const DAY_MS = 86_400_000

const _etDay = (ts) => new Date(ts > 1e12 ? ts : ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const _addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
const _r = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)

const _deps = {
    db:        () => getDb(),
    bars:      (symbol, from, to) => getFmpCandles(symbol, { timeSpan: 'day', multiplier: 1, from, to }),
    earnings:  (from, to) => getEarningsCalendarRaw(from, to),
    perMinute: () => config.dailyScreenerRpm,
    now:       () => Date.now(),
    sleep:     (ms) => new Promise(r => setTimeout(r, ms)),
}
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

/** The report the overnight pass would have seen for session `day`: the first on or after the evening before, within 21 days. Pure. */
export function nextReportFor(dates, day) {
    const from = _addDays(day, -1), to = _addDays(from, EARNINGS_DAYS)
    return (dates ?? []).find(d => d >= from && d <= to) ?? null
}

/**
 * One name's replay over `days` (ascending ET dates) → rows `{ day, symbol, grade, path, outcome }`; grade POOL_GRADE for
 * a name that clears the week's gates but grades nothing. A day with no bar, too little history, a failed gate or a
 * window not complete yet is skipped. Pure. `bars` / `bench` ascending daily bars; `reports` the name's report dates.
 */
export function replaySymbol({ symbol, bars, bench, reports = [], days }) {
    const out = []
    const rows = (bars ?? []).filter(b => b?.close > 0)
    const dateOf = rows.map(b => _etDay(b.timestamp))
    const idxOf = new Map(dateOf.map((d, i) => [d, i]))
    for (const day of days ?? []) {
        const i = idxOf.get(day)
        if (i == null || i < 1) continue
        const stats = screenerStats(rows.slice(0, i), bench)
        if (!stats) continue
        stats.symbol = symbol
        stats.next_earnings = nextReportFor(reports, day)
        const price = rows[i].open > 0 ? rows[i].open : rows[i - 1].close
        if (failedGate('week', stats, { price })) continue
        const c = cell('week', stats, { price, today: day, catalyst: null })
        const win = windowBars('week', day, { daily: rows })
        if (win.length < WEEK_SESSIONS || windowPartial('week', win)) continue
        const outcome = scoreWindow({ entry: price, level: c.range?.level ?? null }, win)
        if (!outcome) continue
        out.push({ day, symbol, grade: c.grade ?? POOL_GRADE, path: c.path ?? null, outcome })
    }
    return out
}

const _median = (xs) => {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
    if (!s.length) return null
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** One group's numbers, as the live record's (hotlist.outcomes): ended up, mean and median return, reached its level. Pure. */
export function groupStats(xs) {
    const judged = xs.filter(o => o.outcome.reached != null)
    return {
        n: xs.length,
        up_rate:    xs.length ? _r((xs.filter(o => o.outcome.ret_pct > 0).length / xs.length) * 100, 1) : null,
        ret_mean:   xs.length ? _r(xs.reduce((s, o) => s + (o.outcome.ret_pct ?? 0), 0) / xs.length) : null,
        ret_median: _r(_median(xs.map(o => o.outcome.ret_pct))),
        hit_rate:   judged.length ? _r((judged.filter(o => o.outcome.reached).length / judged.length) * 100, 1) : null,
        judged:     judged.length,
        mfe_median: _r(_median(xs.map(o => o.outcome.mfe_pct))),
    }
}

/** The replay's rows → per grade, per path, the pool, and the whole graded set. Pure. */
export function summarizeReplay(rows) {
    const graded = rows.filter(r => r.grade !== POOL_GRADE)
    return {
        grades: Object.fromEntries(['A', 'B', 'C'].map(g => [g, groupStats(graded.filter(r => r.grade === g))])),
        paths: Object.fromEntries(['scheduled', 'accumulation'].map(p => [p, groupStats(graded.filter(r => r.path === p))])),
        graded: groupStats(graded),
        pool: groupStats(rows.filter(r => r.grade === POOL_GRADE)),
        sessions: new Set(rows.map(r => r.day)).size,
    }
}

/**
 * Replay This week over the last `sessions` sessions (each with its five sessions after it complete) → the stored
 * summary `{ id: 'week', run_at, from, to, sessions, universe, read, failed, stopped, summary, caveats }`. Never throws
 * on a single name; stops (partial) on the provider's rate limit.
 */
export async function replayWeek({ sessions = REPLAY_SESSIONS, deps = _deps, onProgress = () => {} } = {}) {
    const db = await deps.db()
    const last = await db.collection(STATS).find({}, { projection: { _id: 0, day: 1 } }).sort({ day: -1 }).limit(1).next()
    if (!last?.day) return { ok: false, outcome: 'no_universe' }
    const universe = (await db.collection(STATS).find({ day: last.day }, { projection: { _id: 0, symbol: 1 } }).toArray()).map(r => r.symbol)
    const nowMs = deps.now()
    const from = nowMs - (Math.ceil(sessions * 7 / 5) + HISTORY_DAYS + 10) * DAY_MS
    const pace = createPacer({ perMinute: deps.perMinute(), now: deps.now, sleep: deps.sleep })

    await pace()
    const bench = (await deps.bars('SPY', from, nowMs)) ?? []
    const benchDays = bench.map(b => _etDay(b.timestamp))
    // The replayed sessions: the last `sessions` whose five-session window is complete.
    const days = benchDays.slice(0, Math.max(0, benchDays.length - WEEK_SESSIONS + 1)).slice(-sessions)
    if (!days.length) return { ok: false, outcome: 'no_history' }

    await pace()
    const calendar = await deps.earnings(_addDays(days[0], -1), _addDays(days.at(-1), EARNINGS_DAYS)).catch(() => [])
    const reports = new Map()
    for (const e of calendar ?? []) {
        const s = String(e?.symbol ?? '').toUpperCase()
        if (!s || !e.date) continue
        if (!reports.has(s)) reports.set(s, [])
        reports.get(s).push(e.date)
    }
    for (const list of reports.values()) list.sort()

    const rows = []
    let read = 0, failed = 0, stopped = null
    for (const [k, symbol] of universe.entries()) {
        await pace()
        try {
            const bars = await deps.bars(symbol, from, nowMs)
            rows.push(...replaySymbol({ symbol, bars, bench, reports: reports.get(symbol) ?? [], days }))
            read++
        } catch (err) {
            if (err?.status === 429) { stopped = 'rate_limited'; break }
            failed++
        }
        if ((k + 1) % 100 === 0) onProgress(k + 1, universe.length)
    }

    const doc = {
        id: 'week', column: 'week', run_at: new Date(nowMs).toISOString(), from: days[0], to: days.at(-1),
        sessions: days.length, universe: universe.length, universe_day: last.day, read, failed, stopped,
        summary: summarizeReplay(rows),
        caveats: ['no drift path (no past news labels): scheduled and accumulation only', "today's universe (survivorship)", "entry at the session's open, not the 09:20 quote"],
    }
    await db.collection(BACKTEST).updateOne({ id: 'week' }, { $set: doc }, { upsert: true })
    logger.info(LOG, 'week replay stored', { from: doc.from, to: doc.to, read, failed, stopped, graded: doc.summary.graded.n, pool: doc.summary.pool.n })
    return { ok: !stopped, outcome: stopped ? 'partial' : 'done', ...doc }
}

/** The stored replays, keyed by column — what the API's outcomes carry as `backtest`. Null on none. */
export async function backtestSummary(deps = _deps) {
    const db = await deps.db()
    const docs = await db.collection(BACKTEST).find({}, { projection: { _id: 0 } }).toArray()
    return docs.length ? Object.fromEntries(docs.map(d => [d.column, d])) : null
}
