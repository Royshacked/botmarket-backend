// PROTEUS'S MEASURED PROFILE — how a stock's price behaves, COUNTED from its candles (docs/design/proteus.md §2;
// Roy, 2026-11-12). PURE: bars in, numbers out — no fetch, no model. Proteus interprets the numbers; this file only
// counts. LONG SIDE ONLY for now (§8.3): holds at support, sweeps of lows that turn back up, follow-through up.
//
// ONE OUTCOME for every test, so the numbers compare: from an event, over the next `horizon` bars, does price reach
// `up` ATRs above the entry (a WIN) before it CLOSES `down` ATRs below it (a LOSS)? Neither in time is not a win.
// A close (not a wick) for the loss, and the loss is checked first inside a bar (we cannot see which came first).
//
// EVERY RATE HAS A BASELINE — "TSLA bounces off the 50 MA" means nothing until it beats a line of the same shape that
// is not the 50 MA (screener lab + industry verdicts: price traits look meaningful when they aren't):
//   - a LEVEL (an MA, VWAP, an order block) → the same level SHIFTED up and down by a few typical ranges, the
//     identical touch rule run on each: same trend, same volatility, not the level;
//   - an EVENT (RSI under 30, a MACD cross, a high-volume up bar) → the same outcome from every bar (the drift).
// AND OUT OF SAMPLE (argus-rework §5.2): the history is split by time — the rule is FOUND on the older 2/3 alone (edge
// and z there), and the recent 1/3, which the finding never saw, must still beat its own baseline, or the verdict says
// it faded. Small samples say so ('thin').

import { calcSMASeries, calcEMASeries, calcRSISeries, calcMACDSeries, calcATRSeries, calcVWAPSeries } from '../monitoring/evaluators/structured.evaluator.js'
import { swings, detectOrderBlocks } from './smc.engine.js'
import { findExtrema, cycleStats } from './cycleAnalysis.service.js'

export const PROFILE = Object.freeze({
    horizon: 10,        // bars an outcome has to happen in
    up: 1,              // win: a rise of this many ATRs above the entry
    down: 0.5,          // loss: a close this many ATRs below the entry
    touchTol: 0.25,     // a touch: the bar's low comes within this many ATRs of the level (from above)
    shifts: [-3, -2, 2, 3],   // baseline levels: the real one moved by these many median ATRs
    recentShare: 1 / 3, // the recent check: the last third of the bars
    minN: 15,           // fewer events than this is 'thin'
    minRecent: 5,       // fewer recent events than this cannot confirm
    recentEdge: 0.05,   // the recent third must still beat ITS baseline by this much (not just by a hair)
    edge: 0.10,         // a level/rate edge worth a word: 10 points over the baseline
    z: 3,               // …and not luck. 3, not 2: a profile runs ~36 tests (9 × 4 timeframes); at z 2 a random walk
                        // came out 'respects' on ~2% of them — about one false rule per name (tests: a random walk)
    rsiLow: 30,
    rvol: 2,            // a high-volume bar: twice its 20-bar average
    sweepBack: 3,       // a break of a swing low is FALSE when a close is back above it within this many bars
    swingLookback: 2,
    atrPeriod: 14,
    // G. The price cycle (proteus.md §8.1, 2026-11-13) — the SAME troughs and regularity get_cycle_analysis describes
    // (cycleAnalysis.findExtrema / cycleStats: the share of trough-to-trough intervals within ±35% of their mean).
    cycleLookback: 5,   // a trough: the lowest close of 5 bars each side
    cycleShuffles: 100, // the baseline: the same returns, reshuffled, this many times
    cycleMinN: 8,       // fewer intervals than this in the older two-thirds is 'thin'
    cycleMinRecent: 4,  // …and in the recent third, too few to confirm
})

/** A seeded uniform [0, 1) — the baseline must be the same on every run of the same bars. Pure. */
function _rng(seed) {
    let s = seed >>> 0
    return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 }
}

/** The closes rebuilt from the same bar-to-bar returns in a shuffled order — the same moves, any rhythm gone. Pure. */
function _shuffledPath(closes, rnd) {
    const r = []
    for (let i = 1; i < closes.length; i++) r.push(closes[i] / closes[i - 1])
    for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j], r[i]] }
    const out = [closes[0]]
    for (const x of r) out.push(out.at(-1) * x)
    return out
}

/**
 * G. A PRICE CYCLE that holds (proteus.md §8.1): are the stock's troughs spaced more regularly than its own moves in a
 * random order? Found on the older two-thirds — the regularity (cycleStats.consistency) against the same returns
 * reshuffled `cycleShuffles` times, at z ≥ `z` and `edge` over the baseline — and checked on the recent third, which
 * must still beat it. A cycle that holds states its period and the NEXT WINDOW (the last trough + the period ± its
 * spread); one that does not states none — get_cycle_analysis still describes any cycle on request, this says whether
 * to believe it. Pure (a seeded baseline: the same bars give the same verdict).
 */
export function cycleTest(bars, cut, opts = PROFILE) {
    const closes = bars.map(b => b.close)
    const stat = (c) => cycleStats(findExtrema(c, opts.cycleLookback).troughs)
    const older = stat(closes.slice(0, cut))
    if (!older || older.count < opts.cycleMinN) return { verdict: 'thin', n: older?.count ?? 0 }
    const rnd = _rng(closes.length * 7919 + Math.round(closes[0] * 100))
    const base = []
    for (let k = 0; k < opts.cycleShuffles; k++) {
        const s = stat(_shuffledPath(closes.slice(0, cut), rnd))
        if (s) base.push(s.consistency)
    }
    const mean = base.reduce((a, b) => a + b, 0) / (base.length || 1)
    const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / (base.length || 1))
    const z = sd > 0 ? (older.consistency - mean) / sd : null
    const recent = stat(closes.slice(cut))
    const found = Number.isFinite(z) && z >= opts.z && older.consistency - mean >= opts.edge
    const verdict = !found ? 'no'
        : !recent || recent.count < opts.cycleMinRecent ? 'unconfirmed'
            : recent.consistency - mean >= opts.recentEdge ? 'respects' : 'faded'
    const out = {
        verdict, n: older.count, rate: _round(older.consistency), base: _round(mean), z: _round(z, 2),
        recent: { n: recent?.count ?? 0, rate: _round(recent?.consistency ?? null) },
        period_bars: null, spread_bars: null, window: null,
    }
    if (verdict !== 'respects') return out
    // The window: from the WHOLE history's troughs — the period, its spread, and where the last trough sits.
    const all = findExtrema(closes, opts.cycleLookback).troughs
    const whole = cycleStats(all)
    const step = _median(bars.slice(1).map((b, i) => _ms(b.timestamp) - _ms(bars[i].timestamp)))
    const lastAt = _ms(bars[all.at(-1)].timestamp)
    out.period_bars = whole.mean
    out.spread_bars = whole.std
    out.window = step ? {
        last_low: new Date(lastAt).toISOString(),
        from: new Date(lastAt + Math.max(1, whole.mean - whole.std) * step).toISOString(),
        to: new Date(lastAt + (whole.mean + whole.std) * step).toISOString(),
    } : null
    return out
}

const _ms = (ts) => (ts < 1e12 ? ts * 1000 : ts)
const _mon = (bars) => bars.map(b => ({ t: _ms(b.timestamp), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }))
const _median = (xs) => {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
    if (!v.length) return null
    const m = v.length >> 1
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
/** The q-quantile (nearest rank) of the finite values, or null. Pure. */
const _quantile = (xs, q) => {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
    return v.length ? v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)] : null
}
const _round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null)

/**
 * The one outcome. From bar `i` (the event), bars i+1..i+horizon: 'win' if a high reaches `upLevel` first, 'loss' if
 * a close falls under `downLevel` first (checked first inside a bar), 'none' if neither; null when the bars run out
 * (an unfinished event is not counted). Pure.
 */
export function bracket(bars, i, upLevel, downLevel, horizon = PROFILE.horizon) {
    if (i + horizon >= bars.length) return null
    for (let k = i + 1; k <= i + horizon; k++) {
        if (bars[k].close < downLevel) return 'loss'
        if (bars[k].high >= upLevel) return 'win'
    }
    return 'none'
}

/** Win rate of a list of outcomes (nulls dropped). Pure. */
const _rate = (outs) => {
    const o = outs.filter(Boolean)
    return { n: o.length, wins: o.filter(x => x === 'win').length, rate: o.length ? o.filter(x => x === 'win').length / o.length : null }
}

/**
 * A rate against its baseline → the stats and the verdict. `events`/`base` are `{ i, out }` lists; `cut` the bar index
 * where the recent third starts. The rule is FOUND on the older part (i < cut) only — edge and z there — and CHECKED on
 * the recent part, which the finding never saw (CR 2026-11-12: testing on the whole history let a recent-only edge
 * confirm itself). `n` / `rate` / `base` / `z` are the older part's; `recent` the check's. Pure.
 *   respects    — beat the baseline by `edge` at z ≥ `z` in the older part AND by `recentEdge` in the recent part
 *   faded       — beat it in the older part, not in the recent part
 *   unconfirmed — beat it in the older part, too few recent events to tell
 *   no          — did not beat it in the older part
 *   thin        — too few older events to say anything
 */
export function judge(events, base, cut, opts = PROFILE) {
    const all = _rate(events.filter(e => e.i < cut).map(e => e.out))
    const b = _rate(base.filter(e => e.i < cut).map(e => e.out))
    const rec = _rate(events.filter(e => e.i >= cut).map(e => e.out))
    const recBase = _rate(base.filter(e => e.i >= cut).map(e => e.out))
    const edge = all.rate != null && b.rate != null ? all.rate - b.rate : null
    // Two-proportion z (pooled): the baseline is a sample too, and a small one is noisy.
    const p = Math.min(0.99, Math.max(0.01, (all.wins + b.wins) / ((all.n + b.n) || 1)))
    const z = edge != null && all.n && b.n ? edge / Math.sqrt(p * (1 - p) * (1 / all.n + 1 / b.n)) : null
    let verdict
    if (all.n < opts.minN || b.n < opts.minN) verdict = 'thin'
    else if (!(edge >= opts.edge && z >= opts.z)) verdict = 'no'
    else if (rec.n < opts.minRecent || recBase.n < opts.minN / 3) verdict = 'unconfirmed'
    else verdict = rec.rate - recBase.rate >= opts.recentEdge ? 'respects' : 'faded'
    return {
        verdict, n: all.n, rate: _round(all.rate), base: _round(b.rate), base_n: b.n, edge: _round(edge), z: _round(z, 2),
        recent: { n: rec.n, rate: _round(rec.rate), base: _round(recBase.rate) },
    }
}

/**
 * Touches of a support LEVEL from above, each with its outcome. A touch at bar i: the previous close was above the
 * level, and this bar's low comes within `touchTol` ATRs of it. Win = `up` ATRs above the level; loss = a close
 * `down` ATRs under it. After a touch the next `horizon` bars are skipped (one event, not ten overlapping ones). Pure.
 */
export function levelTouches(bars, level, atrs, opts = PROFILE) {
    const out = []
    for (let i = 1; i < bars.length; i++) {
        const L = level[i], Lp = level[i - 1], a = atrs[i]
        if (!Number.isFinite(L) || !Number.isFinite(Lp) || !Number.isFinite(a) || a <= 0) continue
        // From above: the previous close AND this bar's open sit over the level (a bar that opens under it is not
        // testing it from above — VWAP's first bars of a session were "touches" that way, CR 2026-11-12).
        if (!(bars[i - 1].close > Lp && bars[i].open >= L && bars[i].low <= L + opts.touchTol * a)) continue
        if (bars[i].close < L - opts.down * a) continue   // sliced through on the touch bar: a break, not a test
        const o = bracket(bars, i, L + opts.up * a, L - opts.down * a, opts.horizon)
        if (o == null) break
        out.push({ i, out: o })
        i += opts.horizon
    }
    return out
}

/** A level series moved by `k` median ATRs (in % of price, so it scales with the level). Pure. */
const _shift = (level, k, atrPct) => level.map(v => (Number.isFinite(v) ? v * (1 + k * atrPct / 100) : null))

/** A level series vs its shifted copies → judge(). Pure. */
export function levelTest(bars, level, atrs, atrPct, cut, opts = PROFILE) {
    const events = levelTouches(bars, level, atrs, opts)
    const base = opts.shifts.flatMap(k => levelTouches(bars, _shift(level, k, atrPct), atrs, opts))
    return judge(events, base, cut, opts)
}

/**
 * The same outcome from bars spread `horizon` apart (entry = the close) — the drift an event has to beat. Every bar
 * would overlap its neighbours' windows and count one move ten times, overstating the baseline's sample (CR 2026-11-12).
 * Pure.
 */
export function driftOutcomes(bars, atrs, opts = PROFILE) {
    const out = []
    for (let i = 0; i < bars.length; i++) {
        const a = atrs[i]
        if (!Number.isFinite(a) || a <= 0) continue
        const o = bracket(bars, i, bars[i].close + opts.up * a, bars[i].close - opts.down * a, opts.horizon)
        if (o == null) break
        out.push({ i, out: o })
        i += opts.horizon - 1
    }
    return out
}

/** Event bars (a predicate on i) → their outcomes, entry = the close, overlapping events skipped. Pure. */
export function eventOutcomes(bars, atrs, isEvent, opts = PROFILE) {
    const out = []
    for (let i = 1; i < bars.length; i++) {
        const a = atrs[i]
        if (!Number.isFinite(a) || a <= 0 || !isEvent(i)) continue
        const o = bracket(bars, i, bars[i].close + opts.up * a, bars[i].close - opts.down * a, opts.horizon)
        if (o == null) break
        out.push({ i, out: o })
        i += opts.horizon
    }
    return out
}

/**
 * C. FALSE BREAKS of swing lows (a sweep of the stops under a low). A break: a bar's low goes under a CONFIRMED swing
 * low (confirmed `swingLookback` bars after it) that nothing broke before — any of them, not only the latest (an older,
 * deeper low swept later is a sweep too, CR 2026-11-12); a bar under several is one break, of the lowest. False: a close back above
 * it within `sweepBack` bars. For each false break, the outcome from the reclaim (entry = that bar's close) — does the
 * sweep turn into a move up — judged against the drift. `bars_to_direction`: median bars from the break until a close
 * 1 ATR away from the level, either side. `sweep_depth_atr`: how far under the low the false breaks went (median and
 * 80th percentile, in ATRs) — the room a stop under a swing low needs. Pure.
 */
export function falseBreaks(bars, atrs, cut, drift, opts = PROFILE) {
    const lows = swings(bars, opts.swingLookback).filter(s => s.type === 'low')
    const breaks = []
    let active = []      // confirmed swing lows not broken yet
    let next = 0         // the next low to confirm
    for (let j = 1; j < bars.length; j++) {
        while (next < lows.length && lows[next].i + opts.swingLookback < j) active.push(lows[next++])
        const broken = active.filter(l => bars[j].low < l.price)
        if (!broken.length) continue
        active = active.filter(l => !(bars[j].low < l.price))
        const s = broken.reduce((m, l) => (l.price < m.price ? l : m))
        const a = atrs[j]
        if (!Number.isFinite(a) || a <= 0) continue
        let reclaim = null
        for (let k = j; k < Math.min(bars.length, j + opts.sweepBack); k++) if (bars[k].close > s.price) { reclaim = k; break }
        let toDir = null
        for (let k = j; k < bars.length; k++) if (Math.abs(bars[k].close - s.price) >= a) { toDir = k - j; break }
        // From the reclaim bar's CLOSE, like the drift: measured from the swept level, the loss would sit further
        // away than the drift's and every sweep would look good on noise.
        const ra = reclaim != null ? atrs[reclaim] : null
        const out = reclaim != null && Number.isFinite(ra) && ra > 0
            ? bracket(bars, reclaim, bars[reclaim].close + opts.up * ra, bars[reclaim].close - opts.down * ra, opts.horizon) : undefined
        // How far under the low a FALSE break went before it came back, in ATRs — what a stop under a swing low
        // has to clear to survive the sweep.
        const swept = reclaim != null ? Math.min(...bars.slice(j, reclaim + 1).map(b => b.low)) : null
        const depth = reclaim != null ? (s.price - swept) / a : null
        breaks.push({ i: reclaim ?? j, false: reclaim != null, out, toDir, depth, at: j, level: s.price, swept })
    }
    // THE LATEST FALSE BREAK, as it happened — the example the user is shown on a chart (Roy, 2026-11-13: "how does
    // NVDA behave" needs a chart with an example). One real event from the same count, never a picked one.
    const last = breaks.findLast(b => b.false)
    const latest = last ? {
        at: new Date(_ms(bars[last.at].timestamp)).toISOString(),
        reclaimed_at: new Date(_ms(bars[last.i].timestamp)).toISOString(),
        level: _round(last.level, 2), swept_to: _round(last.swept, 2), depth_atr: _round(last.depth, 2),
    } : null
    // One sweep per outcome window, like every other test: two sweeps a few bars apart share the move that follows.
    const sweeps = []
    for (const b of breaks) {
        if (!b.false || b.out == null) continue
        if (sweeps.length && b.i <= sweeps.at(-1).i + opts.horizon) continue
        sweeps.push({ i: b.i, out: b.out })
    }
    const after = judge(sweeps, drift, cut, opts)
    const n = breaks.length
    const nFalse = breaks.filter(b => b.false).length
    const rec = breaks.filter(b => b.i >= cut)
    return {
        breaks: n,
        false_rate: _round(n ? nFalse / n : null),
        recent: { breaks: rec.length, false_rate: _round(rec.length ? rec.filter(b => b.false).length / rec.length : null) },
        bars_to_direction: _median(breaks.map(b => b.toDir)),
        sweep_depth_atr: { median: _round(_median(breaks.map(b => b.depth)), 2), p80: _round(_quantile(breaks.map(b => b.depth), 0.8), 2) },
        latest,
        after_sweep: after,
    }
}

/**
 * D. BULLISH ORDER BLOCKS (smc.engine) — of those price came back to, how many held. A retest: the first bar after
 * the block is KNOWN — two bars after its impulse candle (the FVG closes on the bar after it; counting earlier dips
 * would score the move that made the block as its first hold, CR 2026-11-12) — whose low reaches the block's top,
 * coming from above (no retest when price never left it). Win = `up` ATRs above the top; loss = a close `down` ATRs
 * under the block's bottom. Baseline: the same zone shifted by the median ATR multiples IN % OF PRICE (like the levels'
 * — a dollar shift means different things as a stock goes from $20 to $200), the same retest rule. Retests closer than
 * `horizon` bars share a move and count once. Pure.
 */
export function orderBlockTest(bars, atrs, atrPct, cut, opts = PROFILE) {
    const at = new Map(bars.map((b, i) => [b.timestamp, i]))
    const blocks = detectOrderBlocks(bars).filter(o => o.type === 'bullish')
        .map(o => ({ ...o, i: at.get(o.at), known: at.get(o.impulseAt) + 2 })).filter(o => o.i != null && Number.isFinite(o.known))
    const retest = (from, top, bottom) => {
        // From ABOVE, like an MA touch: a zone price is already under is not being retested (a shifted-up baseline
        // zone would otherwise "retest" at once, from below, and lose — flattering every real block).
        for (let r = from; r < bars.length; r++) {
            if (bars[r].low > top) continue
            if (!(bars[r - 1].low > top)) return null
            const a = atrs[r]
            if (!Number.isFinite(a) || a <= 0) return null
            if (bars[r].close < bottom - opts.down * a) return { i: r, out: 'loss' }   // sliced through on arrival
            const o = bracket(bars, r, top + opts.up * a, bottom - opts.down * a, opts.horizon)
            return o == null ? null : { i: r, out: o }
        }
        return null
    }
    const from = (o) => Math.max(o.i + 3, o.known)
    const shift = (v, s) => v * (1 + s * atrPct / 100)
    const events = _spaced(blocks.map(o => retest(from(o), o.top, o.bottom)), opts.horizon)
    const base = opts.shifts.flatMap(s => _spaced(blocks.map(o => retest(from(o), shift(o.top, s), shift(o.bottom, s))), opts.horizon))
    return { blocks: blocks.length, ...judge(events, base, cut, opts) }
}

/**
 * One event per outcome window: stacked blocks retested on the same bar, or a few bars apart, share the move that
 * follows — counted apart they would inflate the sample and z. In bar order, an event within `horizon` bars of the
 * last one kept is dropped (CR 2026-11-12). Pure.
 */
function _spaced(list, horizon) {
    const out = []
    for (const e of list.filter(Boolean).sort((a, b) => a.i - b.i)) {
        if (out.length && e.i <= out.at(-1).i + horizon) continue
        out.push(e)
    }
    return out
}

/** ET session day of a bar ("2026-11-11"), for VWAP's daily reset. */
const _etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

/**
 * Session-anchored VWAP over many sessions: calcVWAPSeries (the monitor's math) per ET day. A session's FIRST bar reads
 * null — its VWAP is that bar's own price, so it is no level to test against (and the jump from yesterday's VWAP to
 * today's is not a touch). Pure.
 */
export function sessionVwap(bars) {
    const mon = _mon(bars)
    const out = new Array(bars.length).fill(null)
    let start = 0
    for (let i = 1; i <= bars.length; i++) {
        if (i < bars.length && _etDay.format(new Date(mon[i].t)) === _etDay.format(new Date(mon[start].t))) continue
        const slice = mon.slice(start, i)
        calcVWAPSeries(slice, slice[0].t).forEach((v, k) => { out[start + k] = k ? v : null })
        start = i
    }
    return out
}

const INTRADAY = new Set(['1min', '5min', '15min', '30min', '1hour', 'hour'])

/**
 * One timeframe's profile. `bars` oldest → newest ({ open, high, low, close, volume, timestamp }); `timeframe` decides
 * whether VWAP is tested (intraday) and the gap is measured (daily). Returns null when there are too few bars for the
 * slowest test (the 200 MA) to mean anything. Pure.
 */
export function timeframeProfile(bars, timeframe, opts = PROFILE) {
    if (!Array.isArray(bars) || bars.length < 260) return null
    const intraday = INTRADAY.has(timeframe)
    const mon = _mon(bars)
    const closes = bars.map(b => b.close)
    const atrs = calcATRSeries(mon, opts.atrPeriod)
    const atrPctSeries = atrs.map((a, i) => (Number.isFinite(a) ? (a / closes[i]) * 100 : null))
    const atrPct = _median(atrPctSeries.slice(-20))
    const medAtrPct = _median(atrPctSeries)
    const cut = Math.floor(bars.length * (1 - opts.recentShare))
    const drift = driftOutcomes(bars, atrs, opts)
    const driftAll = _rate(drift.map(d => d.out))

    const levels = {
        ema20: calcEMASeries(closes, 20),
        sma50: calcSMASeries(closes, 50),
        sma200: calcSMASeries(closes, 200),
        ...(intraday ? { vwap: sessionVwap(bars) } : {}),
    }
    const indicators = Object.fromEntries(Object.entries(levels).map(([k, lv]) => [k, levelTest(bars, lv, atrs, medAtrPct, cut, opts)]))

    const rsi = calcRSISeries(closes, 14)
    indicators.rsi_oversold = judge(eventOutcomes(bars, atrs, i => rsi[i - 1] != null && rsi[i - 1] >= opts.rsiLow && rsi[i] < opts.rsiLow, opts), drift, cut, opts)
    const { line, signal } = calcMACDSeries(closes)
    indicators.macd_cross_up = judge(eventOutcomes(bars, atrs, i => line[i - 1] != null && signal[i - 1] != null && line[i - 1] <= signal[i - 1] && line[i] > signal[i], opts), drift, cut, opts)
    const vol20 = calcSMASeries(bars.map(b => b.volume ?? 0), 20)
    indicators.volume_up_bar = judge(eventOutcomes(bars, atrs, i => vol20[i - 1] > 0 && bars[i].volume >= opts.rvol * vol20[i - 1] && bars[i].close > bars[i].open, opts), drift, cut, opts)

    let gapPct = null
    if (timeframe === 'day') gapPct = _median(bars.slice(-60).map((b, k, a) => (k ? Math.abs(b.open / a[k - 1].close - 1) * 100 : null)))
    const last = bars.at(-1)
    const dollarVol = _median(bars.slice(-20).map(b => b.close * (b.volume ?? 0)))

    return {
        timeframe, bars: bars.length,
        from: new Date(_ms(bars[0].timestamp)).toISOString(), to: new Date(_ms(last.timestamp)).toISOString(),
        atr_pct: _round(atrPct, 2), gap_pct: _round(gapPct, 2), dollar_volume: _round(dollarVol, 0),
        drift: { n: driftAll.n, rate: _round(driftAll.rate) },
        indicators,
        false_breaks: falseBreaks(bars, atrs, cut, drift, opts),
        order_blocks: orderBlockTest(bars, atrs, medAtrPct, cut, opts),
        cycle: cycleTest(bars, cut, opts),
    }
}

const _respects = (tf) => (tf ? [
    ...Object.entries(tf.indicators).filter(([, s]) => s.verdict === 'respects').map(([k]) => k),
    ...(tf.false_breaks.after_sweep.verdict === 'respects' ? ['sweeps'] : []),
    ...(tf.order_blocks.verdict === 'respects' ? ['order_blocks'] : []),
    ...(tf.cycle?.verdict === 'respects' ? ['cycle'] : []),
] : [])

/** The thresholds for F — said in the read, so a reader can argue with them. */
export const SUITABILITY = Object.freeze({ dayAtrPct: 2, dayDollarVol: 50e6, swingAtrPctMin: 1, swingAtrPctMax: 8, swingDollarVol: 10e6 })

/**
 * F. Day trade / swing, from the daily ATR and dollar volume (can it move, can it be traded) and whether anything held
 * on the view's own timeframes. A view with nothing that holds is still TRADEABLE — it just has no technical edge to
 * lean on, and says so. Pure.
 */
export function suitability(tfs, s = SUITABILITY) {
    const day = tfs.day
    const atrPct = day?.atr_pct, dv = day?.dollar_volume
    const dayEdges = [..._respects(tfs['5min']), ..._respects(tfs['1hour'])]
    const swingEdges = [..._respects(tfs.day), ..._respects(tfs.week)]
    const view = (moves, liquid, edges) => ({
        fits: Boolean(moves && liquid), edges,
        why: !day ? 'too little daily history (about a year is needed)' : !liquid ? 'too thin to trade' : !moves ? 'does not move enough' : edges.length ? 'moves, liquid, and something holds' : 'moves and liquid, but nothing technical holds',
    })
    return {
        day_trade: view(atrPct >= s.dayAtrPct, dv >= s.dayDollarVol, dayEdges),
        swing: view(atrPct >= s.swingAtrPctMin && atrPct <= s.swingAtrPctMax, dv >= s.swingDollarVol, swingEdges),
    }
}

/** The whole profile: `{ '5min'?, '1hour'?, day?, week? }` bars → each timeframe's profile + F. Pure. */
export function behaviourProfile(symbol, barsByTf, opts = PROFILE) {
    const timeframes = Object.fromEntries(Object.entries(barsByTf ?? {}).map(([tf, bars]) => [tf, timeframeProfile(bars, tf, opts)]))
    return { symbol: String(symbol).toUpperCase(), side: 'long', timeframes, suitability: suitability(timeframes) }
}
