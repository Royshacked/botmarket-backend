// PROMETHEUS'S SCORECARD — every call he makes on coverage, FROZEN the day he makes it and graded against SPY on months
// it has not seen (Roy, 2026-10-27: "do the scorecard"). The coverage document is a living view: a revision overwrites
// its rating and target, so it cannot say what he said back then. This ledger can: one row per CALL — a new rating, a
// new target value or horizon — never rewritten; a later call marks the one before `superseded_at` and both keep being
// graded on their own clocks.
//
// THE GRADE. Entry is the first close after the call (the call's ET day when made before the 16:00 close, else the
// next session). At each MARK — 1, 3, 6, 12, 18, 24 months, up to the call's horizon — the close on (or last before)
// that day against SPY's: `vs_spy`, and `signed` = vs_spy × the rating's direction (buy +, sell −; a hold has none and is
// shown apart). `target_reached` — the first day the high (a sell: the low) touched the target inside the horizon.
// Rows seeded from coverage written before the scorecard are `source: 'backfill'` and shown apart: some of those calls
// were revised after the fact, and none was frozen when made.
//
// Catalyst reads keep their own record (catalystRead.service — graded at the window's end, passes as the control);
// scorecard() reads both and never mixes them.

import { randomUUID } from 'crypto'
import { getDb, stripId } from '../providers/mongodb.provider.js'
import { getTickerAggregates } from '../providers/candles.provider.js'
import { addMonths } from './forecastClock.js'
import { ratingBand } from './ratingBands.js'
import { closeOn } from './houseBook.service.js'
import { COLLECTION as READS } from './catalystRead.service.js'
import { logger } from './logger.service.js'

const LOG = '[prometheusCalls]'
export const COLLECTION = 'prometheus_calls'
const DAY_MS = 86_400_000
const HORIZON_MONTHS = { '3m': 3, '6m': 6, '12m': 12, '18m': 18, '24m': 24 }
/** The marks a call is graded at, in months — each up to its horizon. */
export const MARKS = Object.freeze([1, 3, 6, 12, 18, 24])
/** A mark whose prices never come is closed this long after its day, unpriced. */
export const GIVE_UP_DAYS = 10
/** Under this many graded calls a group's numbers are shown, but flagged too few to judge. */
export const MIN_JUDGE = 20
/** Between two names' bars — the FMP key is shared with live pricing (~300 a minute in all): at most ~150 a minute here. */
export const PACE_MS = 400

const DIRECTION = { strong_buy: 1, buy: 1, hold: 0, sell: -1, strong_sell: -1 }
const _etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const _barDay = (b) => _etDay(b.timestamp > 1e12 ? b.timestamp : b.timestamp * 1000)
const _ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0
const _r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
const _num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

const _deps = {
    db:   () => getDb(),
    bars: (s, from, to) => getTickerAggregates(s, { timeSpan: 'day', multiplier: 1, from, to }).catch(() => null),
    now:  () => Date.now(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
}
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

/** The marks for a horizon, e.g. '6m' → ['1m', '3m', '6m']. Pure. */
export const marksFor = (horizon) => MARKS.filter(m => m <= (HORIZON_MONTHS[horizon] ?? 12)).map(m => `${m}m`)

/** Is `next` a new CALL against `prev` (both coverage documents, prev null at initiation)? A new rating, target value or horizon. Pure. */
export function isNewCall(prev, next) {
    const pt = (c) => [_num(c?.price_target?.value), c?.price_target?.horizon ?? null]
    if (!next?.rating && _num(next?.price_target?.value) === null) return false
    if (!prev) return true
    const [a, ah] = pt(prev), [b, bh] = pt(next)
    return prev.rating !== next.rating || a !== b || ah !== bh
}

/** A coverage document → the frozen call row. Pure. `madeAt` — when the call was made (a backfill: its target's set_at). */
export function callFromCoverage(cov, { madeAt, source = 'forward' } = {}) {
    const horizon = cov?.price_target?.horizon ?? '12m'
    return {
        id: `pc_${cov.symbol}_${randomUUID().slice(0, 8)}`,
        symbol: cov.symbol,
        coverage_id: cov.id ?? null,
        source,
        made_at: madeAt,
        rating: cov.rating ?? null,
        direction: DIRECTION[cov.rating] ?? 0,
        pt: _num(cov.price_target?.value),
        horizon,
        sector: cov.sector ?? null,
        entry: null,
        marks: {},
        target_reached: null,
        superseded_at: null,
        created_at: new Date().toISOString(),
    }
}

/** The ET day whose close is the call's entry: the call's own day when made before the 16:00 close, else the next. Pure. */
export function entryDay(madeAt) {
    const ms = Date.parse(madeAt)
    const clock = new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false })
    return clock < '16:00' ? _etDay(ms) : _etDay(ms + DAY_MS)
}

/** The first bar on or after `day` → `{ day, close }`, or null. Pure. */
function _firstFrom(bars, day) {
    for (const b of bars ?? []) if (_barDay(b) >= day && _ok(b.close)) return { day: _barDay(b), close: b.close }
    return null
}

/**
 * What a grading pass adds to a call → `{ entry, marks, target_reached, done }` (the call's own values carried over),
 * from its daily bars and SPY's (ascending) and today's ET date. Pure. A mark is graded once its day is past and the bars
 * reach it; one still unpriced GIVE_UP_DAYS after its day is closed `unpriced`. `done` once every mark is in.
 */
export function gradeCall(call, bars, spyBars, today) {
    const out = { entry: call.entry, marks: { ...call.marks }, target_reached: call.target_reached }
    if (!out.entry) {
        const day = entryDay(call.made_at)
        const own = _firstFrom(bars, day), spy = own ? closeOn(spyBars, own.day) : null
        if (own && day < today && _ok(spy)) out.entry = { day: own.day, price: own.close, spy }
    }
    const lastBar = bars?.length ? _barDay(bars.at(-1)) : null
    for (const m of marksFor(call.horizon)) {
        if (out.marks[m]) continue
        const base = out.entry?.day ?? entryDay(call.made_at)
        const day = addMonths(`${base}T12:00:00.000Z`, Number.parseInt(m, 10)).slice(0, 10)
        if (!(day < today)) continue
        const late = Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`) > GIVE_UP_DAYS * DAY_MS
        if (!out.entry || !lastBar || lastBar < day) { if (late) out.marks[m] = { day, basis: 'unpriced' }; continue }
        const px = closeOn(bars, day), spy = closeOn(spyBars, day)
        if (!_ok(px) || !_ok(spy)) { if (late) out.marks[m] = { day, basis: 'unpriced' }; continue }
        const ret = (px / out.entry.price - 1) * 100, spyRet = (spy / out.entry.spy - 1) * 100
        out.marks[m] = { day, price: _r2(px), return_pct: _r2(ret), spy_return_pct: _r2(spyRet), vs_spy: _r2(ret - spyRet), signed: call.direction ? _r2((ret - spyRet) * call.direction) : null }
    }
    // The target, inside the horizon: the first session after entry whose high (a sell: low) reached it.
    if (!out.target_reached && out.entry && _ok(call.pt) && call.direction) {
        const end = addMonths(`${out.entry.day}T12:00:00.000Z`, HORIZON_MONTHS[call.horizon] ?? 12).slice(0, 10)
        for (const b of bars ?? []) {
            const d = _barDay(b)
            if (d <= out.entry.day || d > end) continue
            if (call.direction > 0 ? Number(b.high) >= call.pt : Number(b.low) > 0 && Number(b.low) <= call.pt) { out.target_reached = { day: d }; break }
        }
    }
    out.done = marksFor(call.horizon).every(m => out.marks[m])
    return out
}

const _mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const _median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2 }

/** A set of numbers (each a call's % vs SPY, signed) → `{ n, mean, median, beat, judge }`. Pure. */
export function summarise(xs) {
    return { n: xs.length, mean: _r2(_mean(xs)), median: _r2(_median(xs)), beat: xs.length ? _r2(xs.filter(x => x > 0).length / xs.length * 100) : null, judge: xs.length >= MIN_JUDGE }
}

/**
 * The band a call fell in THE DAY IT WAS MADE (services/ratingBands — Roy, 2026-10-28: "if I want to see how the
 * coverages did with the new rating, I need to see it in the scorecard") — its target against its entry price over its
 * horizon. Call-day facts only: not the relabel the live coverage got later, which is not a call. Null without an entry
 * price or a target. Pure.
 */
export function callBand(call) {
    return ratingBand({ target: call?.pt, price: call?.entry?.price, horizon: call?.horizon })?.rating ?? null
}

/**
 * The calls by their band at the call → `{ band: { '1m': summary, … } }`, each mark signed by the BAND's direction (a
 * hold's raw vs SPY). How his calls did under the house's ratings, the bands' order. Pure.
 */
export function byBand(rows) {
    const out = {}
    for (const band of Object.keys(DIRECTION)) {
        const rs = rows.filter(c => callBand(c) === band)
        if (!rs.length) continue
        const dir = DIRECTION[band]
        const marks = Object.fromEntries(MARKS.map(x => `${x}m`).map(m => [m, summarise(rs.map(c => {
            const v = c.marks?.[m]?.vs_spy
            return Number.isFinite(v) ? (dir ? _r2(v * dir) : v) : null
        }).filter(Number.isFinite))]).filter(([, s]) => s.n))
        out[band] = marks
    }
    return out
}

/**
 * The coverage calls' record → per `source` (forward / backfill): every mark's summary of `signed` over the directional
 * calls, the holds' raw `vs_spy` apart, by rating, and the targets reached among calls past their horizon. Pure.
 */
export function coverageRecord(calls) {
    const group = (rows) => {
        const marks = {}
        for (const m of MARKS.map(x => `${x}m`)) {
            const dir = rows.map(c => c.marks?.[m]?.signed).filter(Number.isFinite)
            const holds = rows.filter(c => !c.direction).map(c => c.marks?.[m]?.vs_spy).filter(Number.isFinite)
            if (dir.length || holds.length) marks[m] = { calls: summarise(dir), holds: summarise(holds) }
        }
        const past = rows.filter(c => c.direction && c.done)
        return {
            calls: rows.length, open: rows.filter(c => !c.done).length, marks,
            target: { settled: past.length, reached: past.filter(c => c.target_reached).length },
            by_rating: Object.fromEntries(Object.keys(DIRECTION).map(r => [r, rows.filter(c => c.rating === r)]).filter(([, rs]) => rs.length)
                .map(([r, rs]) => [r, Object.fromEntries(MARKS.map(x => `${x}m`).map(m => [m, summarise(rs.map(c => c.marks?.[m]?.[DIRECTION[r] ? 'signed' : 'vs_spy']).filter(Number.isFinite))]).filter(([, s]) => s.n))])),
            by_band: byBand(rows),
        }
    }
    return { forward: group(calls.filter(c => c.source === 'forward')), backfill: group(calls.filter(c => c.source === 'backfill')) }
}

/**
 * The catalyst reads' record → the BACKED reads (a target: hit / expired) against the PASSES (the control), each on its
 * window's close vs SPY (`window_mark`, catalystRead.service) — the same yardstick both ways — plus the backed hit rate and
 * the passes by reason. Pure.
 *
 * Run-up reads (docs/design/runup-reads.md §4): a confirmed read with no target settles `closed` — backed, but with no
 * target to hit, so the hit rate is over `targeted`; and the run-up reads split by his call on the report (`by_call`:
 * `hold` through it, `exit` before it — event reads and reads from before the call are in neither), so his holds can be
 * judged against the exit.
 */
export function catalystRecord(reads) {
    const marked = (rs) => rs.map(r => r.window_mark?.vs_spy).filter(Number.isFinite)
    const backed = reads.filter(r => ['hit', 'expired', 'closed'].includes(r.status)), passes = reads.filter(r => r.status === 'pass')
    const reasons = [...new Set(passes.map(r => r.pass_reason ?? 'unknown'))]
    // Only run-up reads made the call — an event read never went into a report (code review 2026-10-31).
    const runUp = backed.filter(r => r.through_report?.call)
    return {
        backed: { reads: backed.length, targeted: backed.filter(r => r.status !== 'closed').length, hit: backed.filter(r => r.status === 'hit').length, window: summarise(marked(backed)),
            by_call: Object.fromEntries(['hold', 'exit'].map(k => [k, summarise(marked(runUp.filter(r => r.through_report.call === k)))])) },
        passes: { reads: passes.length, window: summarise(marked(passes)), by_reason: Object.fromEntries(reasons.map(k => [k, summarise(marked(passes.filter(r => (r.pass_reason ?? 'unknown') === k)))])) },
        open: reads.filter(r => r.status === 'active').length,
    }
}

async function _coll(deps) {
    const db = await deps.db()
    return db.collection(COLLECTION)
}

let _indexed = false
async function _ensureIndexes(coll) {
    if (_indexed) return
    await coll.createIndex({ id: 1 }, { unique: true })
    await coll.createIndex({ coverage_id: 1, superseded_at: 1 })
    await coll.createIndex({ done: 1 })
    // One row per call: the same name, source and moment cannot be logged twice (a retried write, a re-run backfill).
    await coll.createIndex({ symbol: 1, source: 1, made_at: 1 }, { unique: true })
    _indexed = true
}

/**
 * Log a coverage call when it IS one (isNewCall against `prev`) → the row, or null. The open call before it on the same
 * coverage is marked superseded. Never throws: the scorecard must never fail the thesis it records.
 */
async function recordCoverageCall(cov, { prev = null, source = 'forward', at = null } = {}, deps = _deps) {
    try {
        if (!isNewCall(prev, cov)) return null
        const coll = await _coll(deps)
        await _ensureIndexes(coll)
        const madeAt = at ?? new Date(deps.now()).toISOString()
        const row = callFromCoverage(cov, { madeAt, source })
        await coll.insertOne({ ...row, done: false })
        // Only an OLDER open call is superseded — a re-run backfill (the insert above throws on a logged call) never
        // reaches here, and a call logged out of order never closes a newer one.
        if (cov.id) await coll.updateMany({ coverage_id: cov.id, source, superseded_at: null, made_at: { $lt: madeAt } }, { $set: { superseded_at: madeAt } })
        logger.info(LOG, 'call logged', { symbol: row.symbol, rating: row.rating, pt: row.pt, horizon: row.horizon, source })
        return stripId(row)
    } catch (err) {
        if (err?.code !== 11000) logger.warn(LOG, 'call not logged (thesis unaffected)', { symbol: cov?.symbol, error: err.message })
        return null
    }
}

/** Grade every open call whose entry or a mark is due → `{ graded, failed }`. Never throws; one name's bars failing skips it. */
async function gradeDue(deps = _deps) {
    const out = { graded: 0, failed: 0 }
    try {
        const coll = await _coll(deps)
        const open = await coll.find({ done: { $ne: true } }).toArray()
        const nowMs = deps.now(), today = _etDay(nowMs)
        const due = open.filter(c => !c.entry || marksFor(c.horizon).some(m => !c.marks?.[m] && addMonths(`${c.entry.day}T12:00:00.000Z`, Number.parseInt(m, 10)).slice(0, 10) < today))
        if (!due.length) return out
        const from = Math.min(...due.map(c => Date.parse(c.made_at))) - 7 * DAY_MS
        const spyBars = await deps.bars('SPY', from, nowMs)
        if (!spyBars?.length) { logger.warn(LOG, 'no SPY bars — grading put off'); return out }
        for (const c of due) {
            try {
                await deps.sleep?.(PACE_MS)
                const bars = await deps.bars(c.symbol, Date.parse(c.made_at) - 7 * DAY_MS, nowMs)
                const g = gradeCall(c, bars ?? [], spyBars, today)
                if (JSON.stringify([g.entry, g.marks, g.target_reached, g.done]) === JSON.stringify([c.entry, c.marks, c.target_reached, Boolean(c.done)])) continue
                await coll.updateOne({ id: c.id }, { $set: { entry: g.entry, marks: g.marks, target_reached: g.target_reached, done: g.done, graded_at: new Date(nowMs).toISOString() } })
                out.graded++
            } catch (err) {
                out.failed++
                logger.warn(LOG, 'one call not graded', { id: c.id, error: err.message })
            }
        }
        if (out.graded || out.failed) logger.info(LOG, 'calls graded', out)
    } catch (err) {
        logger.warn(LOG, 'grading failed', { error: err.message })
    }
    return out
}

/** The scorecard: `{ coverage: coverageRecord, catalyst: catalystRecord, as_of }`. */
async function scorecard(deps = _deps) {
    const db = await deps.db()
    const [calls, reads] = await Promise.all([
        db.collection(COLLECTION).find({}, { projection: { _id: 0, symbol: 1, source: 1, rating: 1, direction: 1, marks: 1, done: 1, target_reached: 1, pt: 1, entry: 1, horizon: 1 } }).toArray(),
        db.collection(READS).find({}, { projection: { _id: 0, status: 1, pass_reason: 1, window_mark: 1, 'through_report.call': 1 } }).toArray(),
    ])
    return { coverage: coverageRecord(calls), catalyst: catalystRecord(reads), as_of: new Date(deps.now()).toISOString(), min_judge: MIN_JUDGE }
}

export const prometheusCallsService = { recordCoverageCall, gradeDue, scorecard }
