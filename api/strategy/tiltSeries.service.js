// The LINE behind each stance — what it has actually earned, day by day, against the benchmark.
//
// A stance already shows one number: `contribution_bp`. The number says where it ended up and
// nothing about how it got there, and those are different facts about a call. A stance that bled
// for five months and snapped back last week reads identically to one that worked from the day it
// was set, and only one of them is a thesis behaving as written.
//
// THE LINE AND THE NUMBER MUST AGREE. This is the whole discipline here. The series is rebased on
// the row's FROZEN baseline (`base_px` / `base_bench_px`), not on the first candle it happens to
// fetch, so its last point is the same relative return `relativeReturnPct` grades from. Rebasing
// on the first bar instead would draw a line that is off by whatever the gap between the frozen
// baseline and that bar's close is — a chart quietly disagreeing with the number printed beside it,
// which is worse than no chart.
//
// WHY THIS IS POSSIBLE NOW. `pythia-tilt.md` said deep daily history was unavailable ("a range
// fetch 403s, ~a month of bars is cached") and used it to justify freezing baselines. Measured
// 2026-09-30, `getTickerAggregates` returns 275 clean daily bars for XLE. That claim predates
// USE_FMP_CANDLES and is dead. The other half of the argument is not: an immutable baseline still
// means a provider revising history cannot silently re-score a closed call, so the baseline stays
// frozen and this module reads bars only to draw between them.

import { getTickerAggregates } from '../../providers/candles.provider.js'
import { createTtlCache }      from '../../services/ttlCache.util.js'
import { toNum }               from '../../services/format.util.js'
import { round2 }              from '../../services/number.util.js'
import { logger }              from '../../services/logger.service.js'

const LOG = '[tiltSeries]'

const DAY_MS = 24 * 60 * 60 * 1000
/** How far back a line may reach. A 24m stance is the longest horizon the clock offers. */
const MAX_LOOKBACK_DAYS = 800
/** Points kept per line. A sparkline in a table row cannot show more, and sending more is waste. */
export const MAX_POINTS = 90

// One entry per (symbol, day). Bars settle after the close and the board is read all day, so an
// hour-long TTL would re-fetch the same settled series a dozen times for one reader. Keyed on the
// day so the first read after midnight refreshes it.
const CANDLE_TTL_MS = 12 * 60 * 60 * 1000
let _cache = createTtlCache({ ttlMs: CANDLE_TTL_MS, max: 120 })

const _io = { fetchBars: (symbol, from, to) => getTickerAggregates(symbol, { timeSpan: 'day', multiplier: 1, from, to }) }
export function _setSeriesIO(io) { Object.assign(_io, io) }

/**
 * Empty the bar cache. For tests that assert what happens when the provider CANNOT be reached —
 * a warm cache answers from memory and never calls it, which is the cache working and the
 * assertion meaning nothing.
 */
export function _clearSeriesCache() { _cache = createTtlCache({ ttlMs: CANDLE_TTL_MS, max: 120 }) }

const _day = ms => new Date(ms).toISOString().slice(0, 10)

/**
 * Daily closes for one symbol → `[{ t, c }]`, oldest first. Cached per (symbol, day).
 *
 * Returns `[]` rather than throwing: a line is an ornament on a number that stands without it, so
 * a provider outage costs the chart and never the board.
 */
export async function closesFor(symbol, fromMs, toMs = Date.now(), io = _io) {
    if (!symbol) return []
    const key = `${symbol}|${_day(fromMs)}|${_day(toMs)}`
    const hit = _cache.get(key)
    if (hit) return hit

    try {
        const bars = await io.fetchBars(symbol, fromMs, toMs)
        const rows = (Array.isArray(bars) ? bars : [])
            .map(b => ({
                // FMP hands back seconds, the Massive path milliseconds. Both are epochs and the
                // difference is three orders of magnitude, so the year 2001 is the cutoff.
                t: Number(b?.timestamp) > 1e12 ? Number(b.timestamp) : Number(b?.timestamp) * 1000,
                c: toNum(b?.close),
            }))
            .filter(p => Number.isFinite(p.t) && p.c !== null && p.c > 0)
            .sort((a, b) => a.t - b.t)
        _cache.set(key, rows)
        return rows
    } catch (err) {
        logger.warn(LOG, `bars unavailable for ${symbol} (the line is skipped, the grade is not)`, err.message)
        return []
    }
}

/**
 * Down-sample to at most `max` points, KEEPING THE LAST. Pure.
 *
 * The last point is the one the number beside the chart is computed from, so dropping it would put
 * a line on screen that ends somewhere the printed contribution does not.
 */
export function thin(points, max = MAX_POINTS) {
    const rows = Array.isArray(points) ? points : []
    if (rows.length <= max) return rows
    const step = (rows.length - 1) / (max - 1)
    const out  = []
    for (let i = 0; i < max - 1; i++) out.push(rows[Math.round(i * step)])
    out.push(rows[rows.length - 1])
    return out
}

/**
 * One stance's relative line → `[{ t, v }]`, where `v` is the bucket's cumulative performance
 * against the benchmark rebased to **100 at the call**. Pure.
 *
 * `v = (px/base_px − bench/base_bench_px + 1) × 100` — the DIFFERENCE of the two simple returns,
 * which is exactly what `relativeReturnPct` computes, offset to sit at 100. 100 means the stance
 * has earned nothing either way; above is the bucket beating the benchmark, whatever both did in
 * absolute terms.
 *
 * ARITHMETIC, NOT GEOMETRIC, and the distinction is not cosmetic. The intuitive form —
 * `(px/base) / (bench/base_bench)` — is the ratio of growth factors, and on a bucket down 6%
 * against a benchmark up 5% it reads −10.48% where the grader reads −11%. Half a point of
 * disagreement between a line and the number printed beside it, every day, invisible unless
 * someone checks. The attribution this desk runs on is arithmetic (`active_bp × relative return`,
 * summed across rows), so the line follows the grader rather than the other way round.
 *
 * Only days where BOTH legs priced are plotted. A day with one leg missing is not a flat day.
 *
 * CONTEXT BEFORE THE CALL. Points dated before `set_at`'s day carry `pre: true`: where the bucket was
 * coming from, on the same scale — rebased on the same frozen baseline, so the line passes 100 at
 * the call and its LAST point is still exactly the graded number. They are context, never part of the
 * stance's performance; the board draws them dimmed and judges "working or not" on the rest.
 */
export function relativeSeries(row, bucketCloses, benchCloses) {
    const base  = toNum(row?.base_px)
    const bBase = toNum(row?.base_bench_px)
    if (base === null || base <= 0 || bBase === null || bBase <= 0) return []

    const setDay = Number.isFinite(Date.parse(row?.set_at ?? '')) ? _day(Date.parse(row.set_at)) : null
    const bench = new Map((Array.isArray(benchCloses) ? benchCloses : []).map(p => [_day(p.t), p.c]))
    const out = []
    for (const p of (Array.isArray(bucketCloses) ? bucketCloses : [])) {
        const b = bench.get(_day(p.t))
        if (!b) continue
        const point = { t: p.t, v: round2((p.c / base - b / bBase + 1) * 100) }
        if (setDay && _day(p.t) < setDay) point.pre = true
        out.push(point)
    }
    return out
}

/** How much history before a call its line shows. A quarter: enough to see the trend it was made into. */
export const CONTEXT_DAYS = 91

/**
 * Every open stance's line for one view → `{ [bucket]: [{t, v}] }`.
 *
 * Each line starts CONTEXT_DAYS before the row's OWN `set_at` — the call's window plus a quarter of
 * where the bucket came from (marked `pre`). A call made today therefore still has a line: all
 * context, ending at the call. Rows share the benchmark fetch — one range covering the earliest
 * start on the table, sliced per row — so a twelve-row view costs thirteen reads, not twenty-four.
 */
export async function seriesForTilt(doc, { nowMs = Date.now(), io = _io } = {}) {
    const rows = (Array.isArray(doc?.tilts) ? doc.tilts : []).filter(r => r?.bucket && r?.proxy?.symbol)
    if (!rows.length) return {}

    const starts = rows.map(r => Date.parse(r.set_at ?? '')).filter(Number.isFinite).map(ms => ms - CONTEXT_DAYS * DAY_MS)
    if (!starts.length) return {}
    const floor = nowMs - MAX_LOOKBACK_DAYS * DAY_MS
    const from  = Math.max(Math.min(...starts), floor)

    const benchSymbol = doc?.benchmark === 'SPX' ? 'SPY' : null
    const benchCloses = benchSymbol ? await closesFor(benchSymbol, from, nowMs, io) : []
    if (!benchCloses.length) {
        logger.warn(LOG, 'no benchmark bars — every line is skipped', { benchmark: doc?.benchmark })
        return {}
    }

    const out = {}
    for (const row of rows) {
        const setMs = Date.parse(row.set_at ?? '')
        const startMs = Number.isFinite(setMs) ? Math.max(setMs - CONTEXT_DAYS * DAY_MS, floor) : from
        // The range always spans the context quarter, so it is never the zero-width request that
        // 403s at the provider — the reason a call made today used to get no line at all.
        const closes  = await closesFor(row.proxy.symbol, startMs, nowMs, io)
        if (!closes.length) continue
        const line = relativeSeries(row, closes, benchCloses.filter(p => p.t >= startMs))
        if (line.length > 1) out[row.bucket] = thin(line)
    }
    return out
}
