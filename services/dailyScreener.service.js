// DailyScreener — the OVERNIGHT pass (docs/design/daily-names.md §6, build phase 2).
//
// Once per trading day, after the close: the liquid US universe (one screener read), each name's
// daily bars (one read each, PACED), the arithmetic in dailyScreener.stats.js, the next earnings
// date, and the universe's breadth. What it writes is small on purpose — one stats document per
// symbol, no bars — because the cluster is an M0 with a 512 MB cap shared by every database
// (project_atlas_quota): ~430 names × well under 1 KB.
//
// OFF BY DEFAULT (DAILY_SCREENER, opt-in), and paced at DAILY_SCREENER_RPM (60) FMP reads a minute:
// the key is shared with live pricing, and its rate limit has not been measured yet (§10). A 429
// ENDS the run — it does not retry its way through the quota live pricing needs — and the run is
// marked partial with what it has. So does a long run of failures (an outage, not bad tickers).
//
// The checkpoint pass (phase 3) reads the latest run's day and the stats stamped with it.

import { getDb } from '../providers/mongodb.provider.js'
import { screenUniverseRaw, getEarningsCalendarRaw } from '../providers/fmp.provider.js'
import { getFmpCandles } from '../providers/fmp.price.provider.js'
import { earningsBySymbol } from './earningsWindow.util.js'
import { createPacer } from './concurrency.util.js'
import { screenerStats, breadthAboveSma20 } from './dailyScreener.stats.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[dailyScreener]'

export const COLLECTION = 'daily_screener_stats'
export const RUNS       = 'daily_screener_runs'

/** How much history a name is read with — enough for the 52-week high with room for holidays. */
const HISTORY_DAYS = 400
/** How far ahead the earnings calendar is read (the week column's window, with margin). */
const EARNINGS_DAYS = 21
/** Stats older than this are dropped: a name that left the universe stops being reported. */
const KEEP_STATS_DAYS = 10
const KEEP_RUNS = 30
/** Consecutive failures that mean an outage rather than a run of bad tickers (the engine's rule). */
const MAX_FAILED_IN_A_ROW = 25
/** A run still `running` after this is a dead process's, and may be taken over. */
const STALE_MS = 2 * 60 * 60 * 1000
/** Read by the Hotlist's "running" line, which treats an older `running` the same way. */
export const RUN_STALE_MS = STALE_MS
/** How often (in names) the pass writes its progress to the run document, for the Floor's Hotlist. */
const PROGRESS_EVERY = 25
/** A pass whose progress has not moved for this long is a dead process's (progress lands every 25
 *  names — under a minute at the default pace), so a crash blocks the retry minutes, not two hours. */
export const HEARTBEAT_STALE_MS = 10 * 60 * 1000
/** Stats are saved in batches of this many names, so a database blip loses one batch, not the night. */
const WRITE_EVERY = 100

/**
 * Is this run document a pass that is still alive? `running`, and its progress moved within
 * HEARTBEAT_STALE_MS — or, before its first progress write, started within STALE_MS. Shared by the
 * claim below and the Hotlist's "running" line, so both read a dead pass the same way. Pure.
 */
export function runIsLive(run, nowMs) {
    if (run?.status !== 'running') return false
    if (Number.isFinite(run.progress_at)) return nowMs - run.progress_at < HEARTBEAT_STALE_MS
    return nowMs - (run.started_at ?? 0) < STALE_MS
}
/** A run that stopped short (a 429, an outage, an empty universe) is tried again ONCE, this long after —
 *  not on every tick, which would spend the shared quota all night on the pass that just hit its limit. */
const RETRY_AFTER_MS = 60 * 60 * 1000
const MAX_ATTEMPTS = 2
const UNFINISHED = new Set(['partial', 'no_universe'])
/** The run is due from this ET time on a trading day — the close is in and FMP has the bar. */
const DUE_ET_MIN = 18 * 60
const OPEN_ET_MIN = 9 * 60 + 30
const SESSION_DAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])

const _deps = {
    db:        () => getDb(),
    universe:  () => screenUniverseRaw(),
    bars:      (symbol, from, to) => getFmpCandles(symbol, { timeSpan: 'day', multiplier: 1, from, to }),
    earnings:  (from, to, symbols) => getEarningsCalendarRaw(from, to, symbols),
    perMinute: () => config.dailyScreenerRpm,
    now:       () => Date.now(),
    sleep:     (ms) => new Promise(r => setTimeout(r, ms)),
}
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

export async function ensureDailyScreenerIndexes() {
    const db = await _deps.db()
    await db.collection(COLLECTION).createIndex({ symbol: 1 }, { unique: true })
    await db.collection(COLLECTION).createIndex({ day: 1 })
    await db.collection(RUNS).createIndex({ id: 1 }, { unique: true })
}

const _ET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
function _etParts(ms) {
    const p = Object.fromEntries(_ET.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
    return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, min: Number(p.hour) * 60 + Number(p.minute) }
}

/**
 * Which trading day's run is due at `nowMs` (ET date, `YYYY-MM-DD`), or null. After 18:00 ET on a
 * weekday → that day. Before the 09:30 open → the PREVIOUS weekday, so a machine that slept through
 * the evening still writes last night's run before the session it is for. In session, or on a
 * weekend after Friday's run window → null. Holidays are not excluded (the app's gate does not
 * either); a holiday run finds yesterday's bar and says so (`stale_bars`). Pure.
 */
export function dueSessionDay(nowMs) {
    const now = _etParts(nowMs)
    if (SESSION_DAYS.has(now.weekday) && now.min >= DUE_ET_MIN) return now.date
    if (now.min >= OPEN_ET_MIN) return null
    // Before the open: the most recent weekday strictly before today.
    for (let back = 1; back <= 3; back++) {
        const p = _etParts(nowMs - back * 86_400_000)
        if (SESSION_DAYS.has(p.weekday)) return p.date
    }
    return null
}

let _active = false

/**
 * The overnight pass for the due day, unless it is done (`force` runs it again). A run that stopped
 * short is tried once more an hour later, then left as it is until the next day's.
 * → `{ ok, outcome, day?, names?, written?, failed?, stopped? }`; outcome is one of
 * `not_due` · `exists` · `already_running` · `no_universe` · `done` · `partial`. Never throws.
 */
export async function runNightly({ force = false, deps = _deps } = {}) {
    if (_active) return { ok: false, outcome: 'already_running' }
    _active = true
    let claimed = null
    try {
        const nowMs = deps.now()
        const day   = dueSessionDay(nowMs)
        if (!day) return { ok: false, outcome: 'not_due' }

        const db   = await deps.db()
        const runs = db.collection(RUNS)
        const id   = `ds_${day}`
        const prior = await runs.findOne({ id })
        if (prior?.status === 'done' && !force) return { ok: true, outcome: 'exists', day }
        if (UNFINISHED.has(prior?.status) && !force
            && ((prior.attempts ?? 1) >= MAX_ATTEMPTS || nowMs - (prior.finished_at ?? 0) < RETRY_AFTER_MS)) {
            return { ok: false, outcome: 'exists', day, status: prior.status }
        }
        if (runIsLive(prior, nowMs)) return { ok: false, outcome: 'already_running', day }
        if (!(await claimRun(runs, id, { day }, prior, nowMs))) return { ok: false, outcome: 'already_running', day }
        claimed = { runs, id }

        // Progress for the Floor's "running" line, and the pass's heartbeat (runIsLive) — best
        // effort, never a reason to stop the pass.
        const progress = (done, of) => runs.updateOne({ id }, { $set: { progress: { done, of }, progress_at: deps.now() } }).catch(() => {})
        const result = await _run(db, day, nowMs, deps, progress, { force })
        await runs.updateOne({ id }, { $set: { ...result, status: result.outcome, finished_at: deps.now() } })
        await _prune(db, runs, day)
        logger.info(LOG, `${day}: ${result.outcome} — ${result.written}/${result.names} names written${result.stopped ? `, stopped: ${result.stopped}` : ''}`)
        return { ok: result.outcome === 'done', ...result, day }
    } catch (err) {
        logger.error(LOG, 'run failed:', err.message)
        // A claimed run that throws is a stopped-short run: `partial`, so the one retry an hour later
        // applies — not `running`, which blocked every retry for two hours (2026-10-22, a DNS blip on
        // the final write). If this write fails too, the heartbeat still frees it in minutes.
        if (claimed) {
            await claimed.runs.updateOne({ id: claimed.id }, { $set: { status: 'partial', stopped: 'error', detail: err.message, finished_at: deps.now() } })
                .catch(() => {})
        }
        return { ok: false, outcome: 'error', detail: err.message }
    } finally {
        _active = false
    }
}

/**
 * Take a run document atomically — matched on the `started_at` this process READ, so of two processes
 * that read the same prior, one wins; false when another holds it. Shared with the checkpoint pass.
 * Counts `attempts`. `insert` is what a new document starts with besides its id.
 */
export async function claimRun(coll, id, insert, prior, nowMs) {
    try {
        const r = await coll.updateOne({ id, started_at: prior?.started_at ?? null }, {
            $setOnInsert: { id, ...insert },
            $set: { status: 'running', started_at: nowMs },
            $inc: { attempts: 1 },
        }, { upsert: true })
        return (r?.matchedCount ?? 0) + (r?.upsertedCount ?? 0) > 0
    } catch (err) {
        if (err?.code === 11000) return false
        throw err
    }
}

async function _run(db, day, nowMs, deps, progress = async () => {}, { force = false } = {}) {
    const universe = await deps.universe()
    if (!universe.length) return { outcome: 'no_universe', names: 0, written: 0, failed: 0, requests: 1 }
    await progress(0, universe.length)

    // A retry picks up where the last attempt stopped: the names already saved for this day are not
    // read again (`force` reads everything).
    const statsColl = db.collection(COLLECTION)
    const have = force ? new Set()
        : new Set((await statsColl.find({ day }, { projection: { symbol: 1 } }).toArray()).map(d => d.symbol))
    let pending = []
    const flush = async () => {
        if (!pending.length) return
        await statsColl.bulkWrite(
            pending.map(d => ({ updateOne: { filter: { symbol: d.symbol }, update: { $set: d }, upsert: true } })),
            { ordered: false })
        pending = []
    }

    const pace = createPacer({ perMinute: deps.perMinute(), now: deps.now, sleep: deps.sleep })
    const from = nowMs - HISTORY_DAYS * 86_400_000
    let requests = 1, failed = 0, inARow = 0, stopped = null

    await pace()
    requests++
    const bench = await deps.bars('SPY', from, nowMs).catch(() => [])

    const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
    const symbols = universe.map(u => String(u.symbol).toUpperCase())
    await pace()
    requests++
    // A failed calendar is SAID on the run (`calendar_failed`): the week board would otherwise read every report date as
    // missing and list nothing, the same as a quiet week (code review 2026-10-25).
    let calendarFailed = false
    const nextEarnings = earningsBySymbol(await deps.earnings(iso(nowMs), iso(nowMs + EARNINGS_DAYS * 86_400_000), symbols).catch(() => { calendarFailed = true; return [] }))

    let read = 0, seen = 0
    for (const u of universe) {
        if (seen > 0 && seen % PROGRESS_EVERY === 0) await progress(seen, universe.length)
        seen++
        const symbol = String(u.symbol).toUpperCase()
        if (have.has(symbol)) continue
        await pace()
        requests++
        let bars
        try {
            bars = await deps.bars(symbol, from, nowMs)
            inARow = 0
        } catch (err) {
            // The rate limit is the provider speaking for the whole key. Stop, rather than spend the
            // quota live pricing is sharing on a pass that can wait for tomorrow.
            if (err?.status === 429) { stopped = 'rate_limited'; break }
            failed++
            if (++inARow >= MAX_FAILED_IN_A_ROW) { stopped = 'outage'; break }
            continue
        }
        const stats = screenerStats(bars, bench)
        if (!stats) { failed++; continue }
        read++
        pending.push({
            symbol, day,
            name: u.companyName ?? null, sector: u.sector ?? null, industry: u.industry ?? null,
            market_cap: u.marketCap ?? null, exchange: u.exchangeShortName ?? u.exchange ?? null,
            next_earnings: nextEarnings.get(symbol)?.date ?? null,
            ...stats,
            updated_at: deps.now(),
        })
        // A failed batch stays pending and goes with the next one; only the LAST write's failure
        // ends the pass (as `partial`, see runNightly).
        if (pending.length >= WRITE_EVERY) {
            await flush().catch(err => logger.warn(LOG, `stats batch not saved, kept for the next one: ${err.message}`))
        }
    }
    await flush()

    // The day's whole set — this attempt's names and any an earlier attempt saved.
    const docs  = await statsColl.find({ day }).toArray()
    const stale = docs.filter(d => d.last_date !== day).length
    const spy   = screenerStats(bench, bench)
    return {
        outcome:     stopped ? 'partial' : 'done',
        names:       universe.length,
        written:     docs.length,
        read,
        reused:      have.size,
        failed,
        stopped,
        requests,
        // A name whose last bar is not the run's day — a holiday, or FMP not yet carrying the close.
        stale_bars:  stale,
        ...(calendarFailed ? { calendar_failed: true } : {}),
        breadth_above_sma20: breadthAboveSma20(docs),
        spy: spy ? { close: spy.close, above_sma20: spy.above_sma20, ret5: spy.ret5, ret20: spy.ret20, atr_pct: spy.atr_pct, over_sma200: spyOverSma200(bench) } : null,
    }
}

/**
 * SPY over its 200-day average at its last close (2026-10-25: the week board's market gate — the run-up loses under it,
 * screener-lab §6). Null short of 200 bars. Pure.
 */
export function spyOverSma200(bench) {
    const closes = (bench ?? []).map(b => b?.close).filter(c => c > 0)
    if (closes.length < 200) return null
    const sma = closes.slice(-200).reduce((s, c) => s + c, 0) / 200
    return closes.at(-1) > sma
}

async function _prune(db, runs, day) {
    const cutoff = new Date(Date.parse(day) - KEEP_STATS_DAYS * 86_400_000).toISOString().slice(0, 10)
    await db.collection(COLLECTION).deleteMany({ day: { $lt: cutoff } })
    const old = await runs.find({}, { projection: { id: 1 } }).sort({ id: -1 }).skip(KEEP_RUNS).toArray()
    if (old.length) await runs.deleteMany({ id: { $in: old.map(r => r.id) } })
}

/** The latest finished run and its day — what phase 3 reads from. Null before the first. */
export async function latestRun(deps = _deps) {
    const db = await deps.db()
    return db.collection(RUNS).find({ status: { $in: ['done', 'partial'] } }).sort({ id: -1 }).limit(1).next()
}
