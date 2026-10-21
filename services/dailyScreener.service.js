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
        if (prior?.status === 'running' && nowMs - (prior.started_at ?? 0) < STALE_MS) return { ok: false, outcome: 'already_running', day }
        if (!(await claimRun(runs, id, { day }, prior, nowMs))) return { ok: false, outcome: 'already_running', day }

        const result = await _run(db, day, nowMs, deps)
        await runs.updateOne({ id }, { $set: { ...result, status: result.outcome, finished_at: deps.now() } })
        await _prune(db, runs, day)
        logger.info(LOG, `${day}: ${result.outcome} — ${result.written}/${result.names} names written${result.stopped ? `, stopped: ${result.stopped}` : ''}`)
        return { ok: result.outcome === 'done', ...result, day }
    } catch (err) {
        logger.error(LOG, 'run failed:', err.message)
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

async function _run(db, day, nowMs, deps) {
    const universe = await deps.universe()
    if (!universe.length) return { outcome: 'no_universe', names: 0, written: 0, failed: 0, requests: 1 }

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
    const nextEarnings = earningsBySymbol(await deps.earnings(iso(nowMs), iso(nowMs + EARNINGS_DAYS * 86_400_000), symbols).catch(() => []))

    const docs = []
    for (const u of universe) {
        const symbol = String(u.symbol).toUpperCase()
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
        docs.push({
            symbol, day,
            name: u.companyName ?? null, sector: u.sector ?? null, industry: u.industry ?? null,
            market_cap: u.marketCap ?? null, exchange: u.exchangeShortName ?? u.exchange ?? null,
            next_earnings: nextEarnings.get(symbol)?.date ?? null,
            ...stats,
            updated_at: deps.now(),
        })
    }

    if (docs.length) {
        await db.collection(COLLECTION).bulkWrite(
            docs.map(d => ({ updateOne: { filter: { symbol: d.symbol }, update: { $set: d }, upsert: true } })),
            { ordered: false })
    }

    const stale = docs.filter(d => d.last_date !== day).length
    const spy   = screenerStats(bench, bench)
    return {
        outcome:     stopped ? 'partial' : 'done',
        names:       universe.length,
        written:     docs.length,
        failed,
        stopped,
        requests,
        // A name whose last bar is not the run's day — a holiday, or FMP not yet carrying the close.
        stale_bars:  stale,
        breadth_above_sma20: breadthAboveSma20(docs),
        spy: spy ? { close: spy.close, above_sma20: spy.above_sma20, ret5: spy.ret5, ret20: spy.ret20, atr_pct: spy.atr_pct } : null,
    }
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
