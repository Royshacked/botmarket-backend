// DailyScreener — the CHECKPOINT pass (docs/design/daily-names.md §5, §6 "Two passes", build phase 3).
//
// At each checkpoint of a trading day: build a POOL of names something is happening to, quote only
// those (paced), label their news, grade them on the checkpoint's columns (hotlist.columns), and
// publish one small BOARD document. The overnight pass (dailyScreener.service) has already done the
// per-name arithmetic; this is what needs today's price.
//
// THE POOL, because there is no batch quote on this plan (§6): fresh news since the last close,
// earnings reported since then, today's rating changes, the movers (in session only — they are
// regular-session data), the names the overnight stats already qualify for the week, and the overnight
// list's best structures. Only names that clear the stats half of a column's gates get in. Capped at
// POOL_MAX, in `buildPool`'s order. There is no pre-market movers source on this plan (probed
// 2026-10-22: batch pre-market 402, the legacy pre-post-market 403).
//
// Same switch as the overnight pass (DAILY_SCREENER), same pace (DAILY_SCREENER_RPM), same rule on a
// 429: the pass stops and publishes what it has, marked partial.

import { getDb } from '../providers/mongodb.provider.js'
import { fetchStockNews, getEarningsCalendarRaw, latestGradesRaw, marketMoversRaw } from '../providers/fmp.provider.js'
import { getFmpQuoteFull, getAftermarketQuote, fmpDateToEpochSec } from '../providers/fmp.price.provider.js'
import { createPacer } from './concurrency.util.js'
import { COLUMNS, cell, relativeVolume, failedGate, weekSetup, rowStatus } from './hotlist.columns.js'
import { labelNews } from './hotlist.news.js'
import { argusRead } from './hotlist.argus.js'
import { BOARDS, outcomeSummary } from './hotlist.outcomes.js'
import { COLLECTION as STATS, latestRun, claimRun } from './dailyScreener.service.js'
import { recordUsage } from './tokenUsage.service.js'
import { houseLedgerUserId } from '../api/user/user.model.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[dailyScreener.checkpoint]'

// The boards' collection is named in hotlist.outcomes (which reads them) so this module can read its
// summary without an import cycle; re-exported for the callers that know it from here.
export { BOARDS }

/**
 * The day's checkpoints (ET minutes). `book` says which quote: the extended-hours book or the session's.
 * `spreadSlack` multiplies the columns' spread gate — 08:00's book is thin, 09:20's is held strict.
 */
export const CHECKPOINTS = Object.freeze([
    { id: 'premarket', etMin: 8 * 60,       columns: ['open', 'week'], book: 'extended', spreadSlack: 3 },
    { id: 'preopen',   etMin: 9 * 60 + 20,  columns: ['open', 'week'], book: 'extended' },
    { id: 'mid',       etMin: 10 * 60 + 30, columns: ['mid'],          book: 'session' },
    { id: 'eod',       etMin: 14 * 60 + 30, columns: ['eod'],          book: 'session' },
    { id: 'close',     etMin: 15 * 60 + 30, columns: ['tomorrow'],     book: 'session' },
])
/** A checkpoint missed by more than this is skipped, not run late — a 10:30 board at 13:00 is wrong. */
const WINDOW_MIN = 30
const POOL_MAX   = 300
/** The week's stats-ready names take at most this much of the pool, so news (the open column's gap
 *  candidates) is never crowded out once money-arriving names join the dated ones. */
export const READY_MAX = 120
/** A 429 is retried this many times, this far apart, before the board stops partial — and a board
 *  waits out at most RETRY_429_BUDGET of them in all (~5 min), so a key held at its limit cannot
 *  stretch a board toward its hour. */
export const RETRY_429 = 3
export const RETRY_429_BUDGET = 15
const RETRY_429_MS = 20_000
const BOARD_MAX  = 30
const KEEP_DAYS  = 10
const NEWS_CHUNK = 50
const STALE_MS   = 60 * 60 * 1000
/** Read by the Hotlist's "running" line, which treats an older `running` board the same way. */
export const BOARD_STALE_MS = STALE_MS
const OPEN_MIN = 9 * 60 + 30, SESSION_MIN = 390
const GRADE_RANK = { A: 3, B: 2, C: 1 }

const _deps = {
    db:        () => getDb(),
    latestRun: () => latestRun(),
    news:      (symbols, from, to) => fetchStockNews({ symbols, from, to, limit: 250 }),
    earnings:  (from, to, symbols) => getEarningsCalendarRaw(from, to, symbols),
    grades:    () => latestGradesRaw(),
    movers:    (kind) => marketMoversRaw(kind),
    extQuote:  (symbol) => getAftermarketQuote(symbol),
    quote:     (symbol) => getFmpQuoteFull(symbol, { fresh: true }),
    label:     (byTicker, opts) => labelNews(byTicker, opts),
    argus:     (board, opts) => argusRead(board, opts),
    // The spend of a board's model calls — the labels and Argus's read, made once for everyone — is
    // the house's: booked to the admin ledger (Roy, 2026-10-21), as monitor spend so it does not eat
    // into that admin's own chat ceiling.
    bookTo:    () => houseLedgerUserId(),
    record:    (userId, model, usage, agent) => recordUsage(userId, model, usage, agent, { monitor: true }),
    // Which columns have earned "verified" (§7) — from the outcome log; a failed read verifies nothing.
    verified:  async () => new Set(Object.entries(await outcomeSummary()).filter(([, s]) => s.verified).map(([c]) => c)),
    perMinute: () => config.dailyScreenerRpm,
    now:       () => Date.now(),
    sleep:     (ms) => new Promise(r => setTimeout(r, ms)),
}
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

export async function ensureHotlistBoardIndexes() {
    const db = await _deps.db()
    await db.collection(BOARDS).createIndex({ id: 1 }, { unique: true })
    await db.collection(BOARDS).createIndex({ day: 1 })
}

const _ET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
function _etNow(ms) {
    const p = Object.fromEntries(_ET.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
    return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, min: Number(p.hour) * 60 + Number(p.minute) }
}

/** The checkpoint whose window `nowMs` falls in, with the ET session date — or null. Pure. */
export function dueCheckpoint(nowMs) {
    const now = _etNow(nowMs)
    if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(now.weekday)) return null
    const cp = CHECKPOINTS.find(c => now.min >= c.etMin && now.min < c.etMin + WINDOW_MIN)
    return cp ? { checkpoint: cp, day: now.date, etMin: now.min } : null
}

/**
 * The pool's sources folded into one ordered list of symbols. Pure. Each source is an iterable of
 * symbols; only names in `eligible` survive (the caller passes those that clear the stats half of a
 * column's gates — a name no column could grade is a wasted quote).
 *
 * Order (Roy, 2026-10-22 — the first live day's pool was 200 news names deep before anything else):
 * earnings reported → names the overnight stats already qualify for the week (`ready`) → rating
 * changes → news (most headlines first) → movers → the best remaining structures.
 */
export function buildPool({ earnings, ready, grades, news, movers, structure }, eligible, max = POOL_MAX) {
    const out = []
    const seen = new Set()
    for (const src of [earnings, ready, grades, news, movers, structure]) {
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
 * The overnight list's week candidates (§2.2 "about to be in play"), strongest RS first. Pure.
 * `ready`: the stats alone already put them in play for the week — a date in the window or money
 * arriving — so a quote is all they need. Otherwise: RS + a structure, still waiting on a catalyst.
 * Both clear the week's stats gates and skip a report within a day. Ranked by RS, not by size: by
 * dollar volume the list was the mega caps (the first live day).
 */
export function structureNames(statsList, today, { ready = false, max = 60 } = {}) {
    return statsList
        .filter(s => {
            if (failedGate('week', s)) return false
            const w = weekSetup(s, today)
            return w.base && !w.binary && (!ready || w.scheduled || w.accumulation)
        })
        .sort((a, b) => (b.rs20 ?? 0) - (a.rs20 ?? 0))
        .slice(0, max)
        .map(s => s.symbol)
}

/** The names a checkpoint could grade at all: the stats half of any of its columns' gates. Pure. */
export function eligibleNames(statsList, columns) {
    return new Set(statsList.filter(s => columns.some(c => !failedGate(c, s))).map(s => s.symbol))
}

/**
 * One name's row on a board: its context and a cell per column. Null when no column graded it. Pure.
 */
export function boardRow(stats, q, columns, { book, etMin, day, catalyst, quotedAt = null, spreadSlack = 1 }) {
    const extended = book === 'extended'
    const prevClose = extended ? stats.close : (q.previousClose ?? stats.close)
    const ctx = extended
        ? { price: q.mid, prevClose, spreadPct: q.spreadPct, spreadSlack, pmVolPct: stats.avg_vol20 > 0 && q.volume != null ? (q.volume / stats.avg_vol20) * 100 : null, catalyst, today: day }
        : { price: q.price, prevClose, open: q.open, dayHigh: q.dayHigh, dayLow: q.dayLow,
            rvol: relativeVolume(q.volume, stats.avg_vol20, (etMin - OPEN_MIN) / SESSION_MIN), catalyst, today: day }
    const cells = Object.fromEntries(columns.map(c => [c, cell(c, stats, ctx)]))
    if (!Object.values(cells).some(c => c.grade)) return null
    const gap = ctx.price > 0 && prevClose > 0 ? ((ctx.price - prevClose) / prevClose) * 100 : null
    return {
        symbol: stats.symbol, name: stats.name ?? null, sector: stats.sector ?? null,
        price: _r(ctx.price, 4), gap_pct: _r(gap), rvol: ctx.rvol ?? null,
        // When the price was read — the outcome log measures from the bars AFTER it (hotlist.outcomes).
        quoted_at: quotedAt,
        pm_vol_pct: _r(ctx.pmVolPct), spread_pct: _r(ctx.spreadPct, 3),
        atr_pct: stats.atr_pct, next_earnings: stats.next_earnings ?? null,
        // The panel's sparkline: the last 20 closes from the overnight pass (none before it saved them).
        spark: Array.isArray(stats.closes20) && stats.closes20.length >= 2 ? stats.closes20 : null,
        catalyst: catalyst ?? null,
        // §3 "priced in?": a minor story under a big gap is a fade candidate, not a follow-through.
        fade_check: catalyst && catalyst.magnitude === 'minor' && gap != null && gap >= 6 ? true : undefined,
        cells: Object.fromEntries(Object.entries(cells).map(([c, v]) => [c, v.grade
            ? { grade: v.grade, why: v.why, range: v.range, ...(v.path ? { path: v.path } : {}), ...(v.exit_before ? { exit_before: v.exit_before } : {}) }
            : { grade: null, ...(v.gate ? { gate: v.gate } : {}) }])),
        // In play / building / setting up — the watchlist's status (hotlist.columns rowStatus).
        status: rowStatus(cells),
    }
}

const _r = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)

/** Best column grade first, then the most room. Pure. */
export function rankRows(rows) {
    const best = r => Math.max(0, ...Object.values(r.cells).map(c => GRADE_RANK[c.grade] ?? 0))
    const room = r => Math.max(-1, ...Object.values(r.cells).map(c => c.range?.open_sky ? 99 : (c.range?.atr_mult ?? -1)))
    return [...rows].sort((a, b) => best(b) - best(a) || room(b) - room(a))
}

let _active = false

/**
 * Run the checkpoint that is due, unless its board exists. → `{ ok, outcome, id?, ... }`; outcome
 * one of `not_due` · `exists` · `already_running` · `no_stats` · `done` · `partial` · `error`.
 * Never throws.
 */
export async function runCheckpoint({ deps = _deps } = {}) {
    if (_active) return { ok: false, outcome: 'already_running' }
    const due = dueCheckpoint(deps.now())
    if (!due) return { ok: false, outcome: 'not_due' }
    _active = true
    try {
        const { checkpoint: cp, day, etMin } = due
        const id = `hb_${day}_${cp.id}`
        const db = await deps.db()
        const boards = db.collection(BOARDS)
        const prior = await boards.findOne({ id })
        if (prior && prior.status !== 'running') return { ok: true, outcome: 'exists', id }
        if (prior?.status === 'running' && deps.now() - (prior.started_at ?? 0) < STALE_MS) return { ok: false, outcome: 'already_running', id }

        const run = await deps.latestRun()
        if (!run?.day) return { ok: false, outcome: 'no_stats', id }
        // Claimed atomically (the overnight pass's claim): two servers on one window build one board.
        if (!(await claimRun(boards, id, { day, checkpoint: cp.id }, prior, deps.now()))) return { ok: false, outcome: 'already_running', id }

        const board = await _build(db, cp, day, etMin, run, deps)
        await boards.updateOne({ id }, { $set: { ...board, finished_at: deps.now() } })
        await boards.deleteMany({ day: { $lt: _daysBefore(day, KEEP_DAYS) } })
        logger.info(LOG, `${id}: ${board.status} — ${board.rows.length} rows from a pool of ${board.counts.pool}${board.stopped ? `, stopped: ${board.stopped}` : ''}`)
        return { ok: board.status === 'done', outcome: board.status, id, rows: board.rows.length, counts: board.counts }
    } catch (err) {
        logger.error(LOG, 'checkpoint failed:', err.message)
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
    // A 429 is waited out before it stops the board: FMP's window lets requests through again after
    // ~18 s, and in session the key is shared with live pricing (and, today, another backend), so a
    // brief spike over the limit is ordinary (2026-10-22: the 10:30 board stopped at its 9th quote).
    // Only a limit that outlasts every retry rethrows, and the caller marks the board partial.
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

    // ── The pool ──
    // Fresh = after the overnight run's session closed (16:00 ET on run.day).
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
        } catch (err) { if (err?.status === 429) stopped = 'rate_limited' }
    }
    const reported = new Set()
    if (!stopped) {
        try {
            for (const e of await paced(() => deps.earnings(run.day, day, universe)) ?? []) {
                if (e?.date && e.date >= run.day && e.date <= day) reported.add(String(e.symbol).toUpperCase())
            }
        } catch (err) { if (err?.status === 429) stopped = 'rate_limited' }
    }
    const rated = new Set()
    if (!stopped) {
        for (const g of await paced(() => deps.grades()) ?? []) {
            if ((Date.parse(g?.publishedDate) / 1000) > sinceSec) rated.add(String(g.symbol).toUpperCase())
        }
    }
    const moving = new Set()
    if (!stopped && cp.book === 'session') {
        for (const kind of ['gainers', 'active']) {
            try { for (const m of await paced(() => deps.movers(kind)) ?? []) moving.add(String(m.symbol).toUpperCase()) }
            catch (err) { if (err?.status === 429) { stopped = 'rate_limited'; break } }
        }
    }
    const news = [...headlines].sort((a, b) => b[1].length - a[1].length).map(([s]) => s)
    const pool = buildPool({
        earnings: reported, grades: rated, news, movers: moving,
        // `ready` is the week column's; the structures stay in every pool as before — in session a
        // strong base can come into play on the tape alone.
        ready:     cp.columns.includes('week') ? structureNames(statsList, day, { ready: true, max: READY_MAX }) : [],
        structure: structureNames(statsList, day),
    }, eligibleNames(statsList, cp.columns))

    // ── Quotes ──
    const quotes = new Map(), quotedAt = new Map()
    for (const sym of pool) {
        if (stopped) break
        try {
            const q = await paced(() => (cp.book === 'extended' ? deps.extQuote(sym) : deps.quote(sym)))
            if (q) { quotes.set(sym, q); quotedAt.set(sym, deps.now()) }
        } catch (err) {
            if (err?.status === 429) stopped = 'rate_limited'
        }
    }

    // ── The ledger the board's model calls are booked to (none found → they run unbooked) ──
    const bookedTo = await Promise.resolve().then(() => deps.bookTo?.() ?? null).catch(() => null)
    const booker = (agent) => (bookedTo && deps.record
        ? (usage, model) => Promise.resolve().then(() => deps.record(bookedTo, model, usage, agent))
            .catch(err => logger.warn(LOG, `${agent} spend not booked: ${err.message}`))
        : undefined)

    // ── News labels: one call for every quoted name that has headlines ──
    const toLabel = new Map([...headlines].filter(([s]) => quotes.has(s)))
    const labels = await deps.label(toLabel, { onUsage: booker('hotlist_news') }).catch(() => new Map())

    // ── The board ──
    const rows = []
    for (const [sym, q] of quotes) {
        const row = boardRow(byStats.get(sym), q, cp.columns, { book: cp.book, etMin, day, catalyst: labels.get(sym) ?? null, quotedAt: quotedAt.get(sym), spreadSlack: cp.spreadSlack ?? 1 })
        if (row) rows.push(row)
    }
    const ranked = rankRows(rows).slice(0, BOARD_MAX)
    const verified = await Promise.resolve().then(() => deps.verified?.() ?? new Set()).catch(() => new Set())
    const regime = { breadth_above_sma20: run.breadth_above_sma20 ?? null, spy: run.spy ?? null }

    // Argus's read of the finished board — once, for everyone (hotlist.argus). Its picks are marked on
    // their rows so the list shows them in place; a failed read leaves the board without one.
    const argus = await Promise.resolve()
        .then(() => deps.argus?.({ day, checkpoint: cp.id, columns: cp.columns, regime, rows: ranked }, { onUsage: booker('hotlist_argus') }) ?? null)
        .catch(() => null)
    const pickBy = new Map((argus?.picks ?? []).map((p, i) => [p.symbol, { ...p, rank: i + 1 }]))
    const avoidBy = new Map((argus?.avoid ?? []).map(a => [a.symbol, a.why]))
    const marked = ranked.map(r => ({
        ...r,
        ...(pickBy.has(r.symbol) ? { pick: pickBy.get(r.symbol) } : {}),
        ...(avoidBy.has(r.symbol) ? { avoid: avoidBy.get(r.symbol) } : {}),
    }))

    return {
        status: stopped ? 'partial' : 'done',
        stopped,
        columns: cp.columns,
        stats_day: run.day,
        // §7: a column's grades are unverified until the outcome log has ~8 weeks of them (hotlist.outcomes).
        unverified_columns: cp.columns.filter(c => !verified.has(c)),
        unverified: cp.columns.some(c => !verified.has(c)),
        regime,
        labels: toLabel.size ? (labels.size ? 'labelled' : 'failed') : 'none',
        booked_to: bookedTo,
        argus: argus ? { summary: argus.summary, model: argus.model, picks: argus.picks.length } : null,
        counts: { pool: pool.length, quoted: quotes.size, graded: rows.length, headlines: headlines.size },
        requests,
        retried_429: retried429,
        rows: marked,
    }
}

/** The latest board of a day (or of the latest day) — what the Floor's Hotlist reads (phase 6). */
export async function latestBoard({ day = null, deps = _deps } = {}) {
    const db = await deps.db()
    const q = { status: { $in: ['done', 'partial'] }, ...(day ? { day } : {}) }
    return db.collection(BOARDS).find(q).sort({ finished_at: -1 }).limit(1).next()
}

export { COLUMNS }
