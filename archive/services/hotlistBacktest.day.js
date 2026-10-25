// THE DAY REPLAY — the Hotlist's day columns (open · mid · eod · tomorrow) run over past sessions, as the week replay
// (hotlistBacktest.service) runs This week (Roy, 2026-10-24: "replay the day columns").
//
// THE SAME RULES, NOT A COPY. Each past session D, for each name in today's universe: the overnight stats from the
// daily bars before D (dailyScreener.stats screenerStats); then, at each column's checkpoint, the QUOTE the board would
// have read, rebuilt from D's 5-minute bars up to that minute (daySnapshot) — price, the session's open, high and low,
// its volume so far — and the live cell (hotlist.columns cell) on it, scored over the live window from that price
// (hotlist.outcomes windowBars / scoreWindow):
//   open      09:20 — the price from D's extended-hours bars (premarketSnapshot); its pre-market volume is not replayed
//   mid       10:30 · eod 14:30 · tomorrow 15:30 — from D's regular-session bars
// A name that clears a column's gates but is not in play is that column's POOL — the control group.
//
// WHAT IT CANNOT REPLAY: the news labels — the open column's "gap on fresh news" — so a beat reported the session before
// stands in (hotlistBacktest earningsBeat), as on the week. The pre-market VOLUME (dayCtx). The live quote's volume counts
// pre-market trading and the session's bars do not, so the replayed relative volume runs under the live one — the same to
// half, checked on 2026-10-23's boards: in session the rules are, if anything, stricter. The spread gate (no past book). And which names a live board
// QUOTES: the checkpoint quotes a pool (movers, news, earnings, structures); here every name passing the gates is judged.
// Survivorship, as the week's.
//
// COST, and what keeps it down: one daily read per name; 5-minute bars only for the sessions a name passed a day column's
// gates (FMP answers about eight sessions a read — read in blocks of BLOCK); pre-market bars only on a day it opened
// gapped (OPEN_GAP_MIN, or half of it with a beat), one read each. Paced at DAILY_SCREENER_RPM; a 429 stops it, and a
// stopped run is not stored. One summary per column in `hotlist_backtest`, shown on that column's list.

import { getDb } from '../../providers/mongodb.provider.js'
import { getFmpCandles } from '../../providers/fmp.price.provider.js'
import { getEarningsCalendarRaw } from '../../providers/fmp.provider.js'
import { screenerStats } from '../../services/dailyScreener.stats.js'
import { COLLECTION as STATS } from '../../services/dailyScreener.service.js'
import { cell, failedGate, relativeVolume } from '../../services/hotlist.columns.js'
import { windowBars, windowPartial, scoreWindow, POOL_GRADE } from '../../services/hotlist.outcomes.js'
import { BACKTEST, earningsBeat, nextReportFor, groupStats } from '../../services/hotlistBacktest.service.js'
import { createPacer } from '../../services/concurrency.util.js'
import { config } from '../../services/config.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[hotlistBacktest.day]'
/** The day columns and the ET minute each one's board reads its quote (dailyScreener.checkpoint CHECKPOINTS). */
export const DAY_CHECKPOINTS = Object.freeze({ open: 9 * 60 + 20, mid: 10 * 60 + 30, eod: 14 * 60 + 30, tomorrow: 15 * 60 + 30 })
/** Sessions replayed by default — about three months (5-minute bars cost a read per BLOCK sessions per name). */
export const DAY_REPLAY_SESSIONS = 60
/** Sessions per 5-minute read: FMP answers ~624 bars (eight sessions) a call; seven leaves room for a stray bar. */
export const BLOCK = 7
/** The open's gap, in %, from which a day's pre-market bars are read (the rule wants 3% at 09:20, or 1.5% on news). */
export const OPEN_GAP_MIN = 2
/** The open's pre-market volume, as % of a day, the replay feeds the rule — "met" (see dayCtx). */
export const PM_VOL_NOT_REPLAYED = 100
const OPEN_MIN = 9 * 60 + 30, SESSION_MIN = 390
const HISTORY_DAYS = 400
const EARNINGS_DAYS = 21
const DAY_MS = 86_400_000

const _et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function _etOf(ts) {
    const p = Object.fromEntries(_et.formatToParts(new Date(ts > 1e12 ? ts : ts * 1000)).map(x => [x.type, x.value]))
    return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) }
}
const _addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
const _sum = (xs) => xs.reduce((s, x) => s + (x || 0), 0)

const _deps = {
    db:        () => getDb(),
    bars:      (symbol, from, to) => getFmpCandles(symbol, { timeSpan: 'day', multiplier: 1, from, to }),
    intraday:  (symbol, fromDay, toDay, extended = false) => getFmpCandles(symbol, { timeSpan: 'minute', multiplier: 5, from: Date.parse(fromDay), to: Date.parse(toDay), extended }),
    earnings:  (from, to) => getEarningsCalendarRaw(from, to),
    perMinute: () => config.dailyScreenerRpm,
    now:       () => Date.now(),
    sleep:     (ms) => new Promise(r => setTimeout(r, ms)),
}
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * The in-session quote at `etMin` from one session's 5-minute bars (ascending): the bars that END by then — a bar
 * stamped 10:25 closes at 10:30. → `{ price, open, dayHigh, dayLow, volume }`, or null before the first bar. Pure.
 */
export function daySnapshot(bars, etMin) {
    const seen = (bars ?? []).filter(b => { const m = _etOf(b.timestamp).min; return m >= OPEN_MIN && m + 5 <= etMin })
    if (!seen.length) return null
    return {
        price:   seen.at(-1).close,
        open:    seen[0].open,
        dayHigh: Math.max(...seen.map(b => b.high)),
        dayLow:  Math.min(...seen.map(b => b.low)),
        volume:  _sum(seen.map(b => b.volume)),
    }
}

/** The pre-market quote at `etMin` (before the open) from a session's extended-hours bars → `{ price, volume }`, or null. Pure. */
export function premarketSnapshot(bars, etMin = DAY_CHECKPOINTS.open) {
    const seen = (bars ?? []).filter(b => { const m = _etOf(b.timestamp).min; return m < OPEN_MIN && m + 5 <= etMin })
    if (!seen.length) return null
    return { price: seen.at(-1).close, volume: _sum(seen.map(b => b.volume)) }
}

/** The checkpoint's ctx for a column, as the live board builds it (dailyScreener.checkpoint boardRow). Pure. */
export function dayCtx(column, stats, snap, { day, catalyst = null } = {}) {
    // The pre-market VOLUME is not replayable: FMP's extended-hours bars carry a fraction of what the live pre-market
    // quote reports (2026-10-24, the 09:20 board's names: 3–25× less), so the open's "on 1% of a day's volume" is taken
    // as met — the open is judged on its 09:20 gap. The price matches the live quote to a few cents.
    if (column === 'open') return { price: snap.price, prevClose: stats.close, pmVolPct: PM_VOL_NOT_REPLAYED, catalyst, today: day }
    return {
        price: snap.price, prevClose: stats.close, open: snap.open, dayHigh: snap.dayHigh, dayLow: snap.dayLow,
        rvol: relativeVolume(snap.volume, stats.avg_vol20, (DAY_CHECKPOINTS[column] - OPEN_MIN) / SESSION_MIN), catalyst, today: day,
    }
}

/** Does session D's open gap enough to read its pre-market bars (OPEN_GAP_MIN; half with a beat)? Pure. */
export function openGapped(prevClose, open, beat) {
    if (!(prevClose > 0) || !(open > 0)) return false
    const gap = (open / prevClose - 1) * 100
    return gap >= (beat ? OPEN_GAP_MIN / 2 : OPEN_GAP_MIN)
}

/**
 * One name's stats for each replayed session it has a bar on → `Map(day → { i, stats, beat, gates })`, `gates` the day
 * columns whose gates it passes at the open. Pure. What decides which intraday bars to read.
 */
export function sessionPlan({ symbol, rows, bench, reports = [], results = new Map(), days }) {
    const dateOf = rows.map(b => _etOf(b.timestamp).date)
    const idxOf = new Map(dateOf.map((d, i) => [d, i]))
    const plan = new Map()
    for (const day of days ?? []) {
        const i = idxOf.get(day)
        if (i == null || i < 1) continue
        const stats = screenerStats(rows.slice(0, i), bench)
        if (!stats) continue
        stats.symbol = symbol
        stats.next_earnings = nextReportFor(reports, day)
        const price = rows[i].open > 0 ? rows[i].open : rows[i - 1].close
        const gates = Object.keys(DAY_CHECKPOINTS).filter(c => !failedGate(c, stats, { price }))
        if (!gates.length) continue
        plan.set(day, { i, stats, beat: earningsBeat(results.get(dateOf[i - 1])), gates })
    }
    return plan
}

/**
 * One name's day-column replay → rows `{ day, symbol, column, grade, path, outcome }` (grade POOL_GRADE: cleared the
 * gates, not in play). `intraday` / `premarket` are `Map(day → 5-minute bars)`; a day with no regular-session bars is
 * skipped, and without pre-market bars (a day that did not open gapped) the open column reads D's open. A window short
 * of its span is skipped. Pure.
 */
export function replayDaySymbol({ symbol, rows, plan, intraday = new Map(), premarket = new Map() }) {
    const out = []
    for (const [day, { i, stats, beat, gates }] of plan) {
        const session = intraday.get(day)
        if (!session?.length) continue
        for (const column of gates) {
            let snap
            if (column === 'open') {
                const pm = premarketSnapshot(premarket.get(day))
                snap = pm ?? { price: rows[i].open }
            } else snap = daySnapshot(session, DAY_CHECKPOINTS[column])
            if (!(snap?.price > 0)) continue
            const c = cell(column, stats, dayCtx(column, stats, snap, { day, catalyst: beat }))
            if (c.gate) continue
            const win = windowBars(column, day, { intraday: session, daily: rows })
            if (!win.length || windowPartial(column, win)) continue
            const outcome = scoreWindow({ entry: snap.price, level: c.range?.level ?? null }, win)
            if (!outcome) continue
            // Which way in, on the open: the volume gap, or the gap on news (the beat standing in).
            const path = c.grade && column === 'open' ? (c.why.some(w => w.includes('fresh news')) ? 'catalyst' : 'gap') : null
            out.push({ day, symbol, column, grade: c.grade ?? POOL_GRADE, ...(path ? { path } : {}), outcome })
        }
    }
    return out
}

/** The replay's rows → per day column: the grades, the screener's names, the pool (and the open's ways in). Pure. */
export function summarizeDayReplay(rows) {
    return Object.fromEntries(Object.keys(DAY_CHECKPOINTS).map(column => {
        const mine = rows.filter(r => r.column === column)
        const graded = mine.filter(r => r.grade !== POOL_GRADE)
        return [column, {
            grades: Object.fromEntries(['A', 'B', 'C'].map(g => [g, groupStats(graded.filter(r => r.grade === g))])),
            ...(column === 'open' ? { paths: { catalyst: groupStats(graded.filter(r => r.path === 'catalyst')), gap: groupStats(graded.filter(r => r.path === 'gap')) } } : {}),
            graded: groupStats(graded),
            pool: groupStats(mine.filter(r => r.grade === POOL_GRADE)),
            sessions: new Set(mine.map(r => r.day)).size,
        }]
    }))
}

/** Split `days` (ascending) into blocks of BLOCK, keeping the ones `want` has a day in. Pure. */
export function blocksFor(days, want) {
    const out = []
    for (let k = 0; k < days.length; k += BLOCK) {
        const b = days.slice(k, k + BLOCK)
        if (b.some(d => want.has(d))) out.push(b)
    }
    return out
}

/**
 * Replay the day columns over the last `sessions` sessions (each with the session after it complete, for tomorrow) →
 * `{ ok, outcome, from, to, sessions, universe, read, failed, stopped, reads, summary }`, one document per column
 * stored. Never throws on a single name; stops (not stored) on the provider's rate limit.
 */
export async function replayDays({ sessions = DAY_REPLAY_SESSIONS, limit = null, deps = _deps, onProgress = () => {} } = {}) {
    const db = await deps.db()
    const last = await db.collection(STATS).find({}, { projection: { _id: 0, day: 1 } }).sort({ day: -1 }).limit(1).next()
    if (!last?.day) return { ok: false, outcome: 'no_universe' }
    const all = (await db.collection(STATS).find({ day: last.day }, { projection: { _id: 0, symbol: 1 } }).toArray()).map(r => r.symbol)
    // `limit` — a smoke run over the first few names: printed, never stored.
    const universe = limit > 0 ? all.slice(0, limit) : all
    const nowMs = deps.now()
    const from = nowMs - (Math.ceil(sessions * 7 / 5) + HISTORY_DAYS + 10) * DAY_MS
    const pace = createPacer({ perMinute: deps.perMinute(), now: deps.now, sleep: deps.sleep })

    await pace()
    const bench = (await deps.bars('SPY', from, nowMs)) ?? []
    const benchDays = bench.map(b => _etOf(b.timestamp).date)
    // Tomorrow's window is the next session: the last replayed day has one after it.
    const days = benchDays.slice(0, Math.max(0, benchDays.length - 1)).slice(-sessions)
    if (!days.length) return { ok: false, outcome: 'no_history' }

    await pace()
    let calendar
    try {
        calendar = await deps.earnings(_addDays(days[0], -5), _addDays(days.at(-1), EARNINGS_DAYS))
    } catch (err) {
        logger.warn(LOG, 'day replay stopped — the earnings calendar was not read', { error: err.message })
        return { ok: false, outcome: 'no_calendar' }
    }
    const reports = new Map(), results = new Map()
    for (const e of calendar ?? []) {
        const s = String(e?.symbol ?? '').toUpperCase()
        if (!s || !e.date) continue
        if (!reports.has(s)) { reports.set(s, []); results.set(s, new Map()) }
        reports.get(s).push(e.date)
        results.get(s).set(e.date, e)
    }
    for (const list of reports.values()) list.sort()

    const out = []
    let read = 0, failed = 0, stopped = null, reads = 0
    for (const [k, symbol] of universe.entries()) {
        try {
            await pace(); reads++
            const rows = ((await deps.bars(symbol, from, nowMs)) ?? []).filter(b => b?.close > 0)
            const plan = sessionPlan({ symbol, rows, bench, reports: reports.get(symbol) ?? [], results: results.get(symbol) ?? new Map(), days })
            const intraday = new Map(), premarket = new Map()
            for (const block of blocksFor(days, plan)) {
                await pace(); reads++
                for (const b of (await deps.intraday(symbol, block[0], block.at(-1))) ?? []) {
                    const d = _etOf(b.timestamp).date
                    if (!intraday.has(d)) intraday.set(d, [])
                    intraday.get(d).push(b)
                }
            }
            for (const [day, p] of plan) {
                if (!p.gates.includes('open') || !intraday.has(day) || !openGapped(rows[p.i - 1].close, rows[p.i].open, p.beat)) continue
                await pace(); reads++
                premarket.set(day, ((await deps.intraday(symbol, day, day, true)) ?? []).filter(b => _etOf(b.timestamp).date === day))
            }
            // Only what the summary reads: a full run is ~280,000 rows (2026-10-24: one was stopped for the machine's memory).
            for (const r of replayDaySymbol({ symbol, rows, plan, intraday, premarket })) {
                out.push({ day: r.day, column: r.column, grade: r.grade, ...(r.path ? { path: r.path } : {}),
                    outcome: { ret_pct: r.outcome.ret_pct, reached: r.outcome.reached, mfe_pct: r.outcome.mfe_pct } })
            }
            read++
        } catch (err) {
            if (err?.status === 429) { stopped = 'rate_limited'; break }
            failed++
        }
        if ((k + 1) % 50 === 0) onProgress(k + 1, universe.length, reads)
    }

    const summary = summarizeDayReplay(out)
    const base = { run_at: new Date(nowMs).toISOString(), from: days[0], to: days.at(-1), universe: universe.length, universe_day: last.day, read, failed, stopped, kind: 'day' }
    const result = { ...base, sessions: days.length, reads, summary }
    if (stopped) {
        logger.warn(LOG, 'day replay stopped short — the stored ones kept', { read, failed, stopped })
        return { ok: false, outcome: 'partial', ...result }
    }
    if (limit > 0) return { ok: true, outcome: 'smoke', ...result }
    const caveats = [
        "the open's \"gap on news\" is an earnings-beat stand-in (EPS beat 5%+, revenue not missed, reported the session before) — other news is not replayed",
        'every name passing the gates is judged — a live board quotes only its pool (movers, news, earnings, structures)',
        "the open's pre-market volume is not replayed (the past bars carry a fraction of the live quote's) — judged on its 09:20 gap",
        "relative volume from the session's bars runs under the live quote's (which counts pre-market trading; 2026-10-23: the same, to half) — in session the rules are stricter than live",
        'no spread gate (no past book)', "today's universe (survivorship)",
    ]
    for (const [column, s] of Object.entries(summary)) {
        await db.collection(BACKTEST).updateOne({ id: column }, { $set: { id: column, column, ...base, sessions: s.sessions, summary: s, caveats } }, { upsert: true })
    }
    logger.info(LOG, 'day replay stored', { from: base.from, to: base.to, read, failed, reads })
    return { ok: true, outcome: 'done', ...result }
}
