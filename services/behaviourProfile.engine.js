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
import { STRUCTURE, atr as structureAtr, swings as structureSwings } from './swingStructure.service.js'

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
    // C2. The false-break rate's baseline (2026-11-13): the same bars in a shuffled order, this many times.
    fbShuffles: 30,
    // H. Wyckoff (2026-11-13): a trading range is `rangeBars` bars spanning at most `rangeAtr` × their median ATR; a
    // dry-up retest comes on volume under `dryUp` × the range's average.
    rangeBars: 20,
    rangeAtr: 4,
    dryUp: 0.7,
    // I. Fibonacci pullbacks (2026-11-13): an impulse is a swing low → swing high of at least `fibImpulseAtr` ATRs; its
    // pullback is watched for up to `fibMaxBars` bars. The Fibonacci ratios against ratios that are not.
    fibImpulseAtr: 4,
    fibMaxBars: 60,
    fibRatios: [0.382, 0.5, 0.618],
    fibBase: [0.2, 0.3, 0.44, 0.56, 0.7, 0.8],
    // J. The stop's room (5b): stops this many ATRs under the trader's swing low — his own (STRUCTURE.buffer) and deeper.
    stopBuffers: [0.2, 0.5, 1],
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
    // In TRADING time (CR 2026-11-13: a 20-session period was added as 20 calendar days — a week early, on a Sunday): N
    // bars ahead is how long N bars have actually taken in this history (weekends, nights and holidays included).
    const lastAt = _ms(bars[all.at(-1)].timestamp)
    // A daily or weekly window that lands on a weekend opens on the Monday after it (a median of elapsed times can).
    const daily = _elapsed(bars, 1) >= 20 * 3_600_000
    const weekday = (ms) => { const d = new Date(ms).getUTCDay(); return daily && (d === 6 || d === 0) ? ms + (d === 6 ? 2 : 1) * 86_400_000 : ms }
    const ahead = (n) => { const e = _elapsed(bars, Math.max(1, Math.round(n))); return e == null ? null : weekday(lastAt + e) - lastAt }
    const near = ahead(whole.mean - whole.std), far = ahead(whole.mean + whole.std)
    out.period_bars = whole.mean
    out.spread_bars = whole.std
    out.window = near != null && far != null ? {
        last_low: new Date(lastAt).toISOString(),
        from: new Date(lastAt + near).toISOString(),
        to: new Date(lastAt + far).toISOString(),
    } : null
    return out
}

const _ms = (ts) => (ts < 1e12 ? ts * 1000 : ts)
/** How long `n` bars have taken in this history, in ms — the median over the bars (sampled). Null when too short. Pure. */
function _elapsed(bars, n) {
    if (bars.length <= n) return null
    const step = Math.max(1, Math.floor((bars.length - n) / 400))
    const xs = []
    for (let i = 0; i + n < bars.length; i += step) xs.push(_ms(bars[i + n].timestamp) - _ms(bars[i].timestamp))
    return _median(xs)
}
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
        // Still unfolding (CR 2026-11-13): no reclaim yet only because the bars ran out — neither false nor true yet.
        if (reclaim == null && j + opts.sweepBack > bars.length) continue
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
    const old = breaks.filter(b => b.i < cut)
    const result = {
        breaks: n,
        false_rate: _round(n ? nFalse / n : null),
        older: { breaks: old.length, false_rate: _round(old.length ? old.filter(b => b.false).length / old.length : null) },
        recent: { breaks: rec.length, false_rate: _round(rec.length ? rec.filter(b => b.false).length / rec.length : null) },
        bars_to_direction: _median(breaks.map(b => b.toDir)),
        sweep_depth_atr: { median: _round(_median(breaks.map(b => b.depth)), 2), p80: _round(_quantile(breaks.map(b => b.depth), 0.8), 2) },
        latest,
        after_sweep: after,
    }
    // The sweep events themselves — what a Wyckoff spring must beat (an ordinary false break, wyckoffTest). Not
    // enumerable: the stored profile keeps the numbers, never the events.
    Object.defineProperty(result, 'sweeps', { value: sweeps, enumerable: false })
    return result
}

/**
 * H. WYCKOFF, MEASURED (proteus.md §8.1, 2026-11-13). TRADING RANGES are found in code: `rangeBars` bars whose high-to-low
 * span is at most `rangeAtr` × their median ATR — tighter than noise's typical ~5.6 ATR over 20 bars — held until a close
 * outside them. Inside a range, three long-side tests, each found on the older two-thirds and checked on the recent third:
 *   - SPRINGS: a dip under the range low closed back inside within `sweepBack` bars, from the reclaim — against the drift
 *     AND against an ordinary false break elsewhere (the falseBreaks sweeps): a spring is only Wyckoff's if it beats both;
 *   - BREAKOUTS (sign of strength): a close above the range high, against the drift; the share that closed straight back
 *     inside within `sweepBack` bars is the UPTHRUST rate (said, not tested — the long side's failure);
 *   - DRY-UP RETESTS: a retest of the range low on volume under `dryUp` × the range's average, against the retests
 *     that were NOT dry (a baseline holding the event itself pulls the two rates together — CR 2026-11-13).
 * `current`: the range the last bar is inside, if any — where it stands now. The PHASE (A–E) is a chart read, never
 * measured. Pure.
 */
export function wyckoffTest(bars, atrs, cut, drift, sweeps, opts = PROFILE) {
    const springs = [], breakouts = [], retests = [], dry = []
    let ranges = 0, upthrusts = 0, current = null
    const spaced = (list, i) => !list.length || i > list.at(-1).i + opts.horizon   // one event per outcome window
    let i = opts.rangeBars
    while (i < bars.length) {
        const from = i - opts.rangeBars, win = bars.slice(from, i)
        const hi = Math.max(...win.map(x => x.high)), lo = Math.min(...win.map(x => x.low))
        const a = _median(atrs.slice(from, i))
        if (!Number.isFinite(a) || a <= 0 || hi - lo > opts.rangeAtr * a) { i++; continue }
        ranges++
        const avgVol = win.reduce((t, x) => t + (x.volume ?? 0), 0) / win.length
        let j = i, ended = false
        for (; j < bars.length; j++) {
            const bar = bars[j], at = atrs[j]
            if (!Number.isFinite(at) || at <= 0) continue
            if (bar.close > hi) {         // a breakout (sign of strength) — the range ends here
                const o = bracket(bars, j, bar.close + opts.up * at, bar.close - opts.down * at, opts.horizon)
                if (o != null && spaced(breakouts, j)) {
                    breakouts.push({ i: j, out: o })
                    if (bars.slice(j + 1, j + 1 + opts.sweepBack).some(x => x.close < hi)) upthrusts++
                }
                // The next range is looked for after this breakout's window: its 20 bars would otherwise still hold the
                // old range, and one rally would break out again and again (CR 2026-11-13).
                j += opts.horizon - 1
                ended = true; break
            }
            if (bar.low < lo) {           // under the range low: a SPRING if a close is back inside soon, else a breakdown
                let k = -1
                for (let m = j; m < Math.min(bars.length, j + opts.sweepBack); m++) if (bars[m].close > lo) { k = m; break }
                if (k < 0) {
                    if (j + opts.sweepBack > bars.length) break   // the last bars: not a breakdown yet (CR 2026-11-13)
                    ended = true; break
                }
                const ak = atrs[k]
                const o = Number.isFinite(ak) && ak > 0 ? bracket(bars, k, bars[k].close + opts.up * ak, bars[k].close - opts.down * ak, opts.horizon) : null
                if (o != null && spaced(springs, k)) springs.push({ i: k, out: o })
                j = k
                continue
            }
            // A retest of the low from above: this bar's low comes within touchTol ATRs of it, the last close did not.
            if (bar.low <= lo + opts.touchTol * at && bars[j - 1].close > lo + opts.touchTol * at && spaced(retests, j)) {
                const o = bracket(bars, j, bar.close + opts.up * at, bar.close - opts.down * at, opts.horizon)
                if (o != null) {
                    if (avgVol > 0 && (bar.volume ?? 0) < opts.dryUp * avgVol) dry.push({ i: j, out: o })
                    else retests.push({ i: j, out: o })   // the baseline: the retests that were NOT dry (CR 2026-11-13)
                }
            }
        }
        if (!ended) current = { low: _round(lo, 2), high: _round(hi, 2), since: new Date(_ms(bars[from].timestamp)).toISOString() }
        i = j + 1
    }
    // The spring's second baseline: ordinary false breaks of swing lows that are NOT themselves springs (a spring is
    // often a swing-low sweep too — counting it on both sides would pull the two rates together).
    // The same dip reclaims the range low and a swing low on bars a little apart (CR 2026-11-13) — within sweepBack is one.
    const same = (e) => springs.some(sp => Math.abs(sp.i - e.i) <= opts.sweepBack)
    const vsDrift = judge(springs, drift, cut, opts), vsSweeps = judge(springs, (sweeps ?? []).filter(e => !same(e)), cut, opts)
    // Wyckoff's only when it beats BOTH an ordinary bar and an ordinary false break: the weaker verdict of the two.
    const vs = [vsDrift.verdict, vsSweeps.verdict]
    const verdict = vs.includes('thin') ? 'thin' : vs.includes('no') ? 'no' : vs.includes('faded') ? 'faded' : vs.includes('unconfirmed') ? 'unconfirmed' : 'respects'
    return {
        ranges, current,
        springs: { ...vsDrift, verdict, vs_sweeps: { rate: vsSweeps.rate, base: vsSweeps.base, base_n: vsSweeps.base_n, z: vsSweeps.z, verdict: vsSweeps.verdict } },
        breakouts: { ...judge(breakouts, drift, cut, opts), upthrust_rate: _round(breakouts.length ? upthrusts / breakouts.length : null) },
        dry_up: judge(dry, retests, cut, opts),
    }
}

/**
 * I. FIBONACCI PULLBACKS, MEASURED (proteus.md §8.1, 2026-11-13). An IMPULSE: a confirmed swing low to the next confirmed
 * swing high, at least `fibImpulseAtr` ATRs tall. Its PULLBACK is watched from the high's confirmation until a close above
 * the high (a new leg), a close under the low (the impulse undone) or `fibMaxBars` bars. Each retracement level is
 * counted at its FIRST touch from above (the last close over it, this bar's low within `touchTol` ATRs), with the one
 * outcome from the level — like a moving average. The Fibonacci levels (`fibRatios`) against levels at ratios that are
 * not Fibonacci (`fibBase`, either side of them) on the SAME pullbacks: same trend, same volatility, not the ratio.
 * Pooled across the three ratios (one test, not three); one event per pullback on each side, its level drawn at random. The Elliott COUNT is never measured — this is the part of
 * Elliott that can be. Pure.
 */
export function fibPullbackTest(bars, atrs, cut, opts = PROFILE) {
    const sw = swings(bars, opts.swingLookback)
    const fib = [], base = []
    let impulses = 0, low = null, lastEnd = -1, latest = null
    const rnd = _rng(bars.length * 7919 + Math.round(bars[0].close * 100))
    for (const s of sw) {
        if (s.type === 'low') { if (!low || s.price < low.price || low.used) low = { ...s, used: false }; continue }
        if (!low || low.used || s.i <= low.i) continue
        const a = atrs[s.i]
        const start = s.i + opts.swingLookback + 1   // the high is known only once confirmed — no look-ahead
        if (!Number.isFinite(a) || a <= 0 || s.price - low.price < opts.fibImpulseAtr * a || start <= lastEnd) continue
        low.used = true
        impulses++
        const span = s.price - low.price
        const level = (r) => s.price - r * span
        const touched = new Set(), mine = { fib: [], base: [] }
        let end = Math.min(bars.length, start + opts.fibMaxBars)
        for (let j = start; j < end; j++) {
            const b = bars[j], aj = atrs[j]
            if (b.close > s.price || b.close < low.price) { end = j; break }
            if (!Number.isFinite(aj) || aj <= 0) continue
            for (const [r, list] of [...opts.fibRatios.map(r => [r, mine.fib]), ...opts.fibBase.map(r => [r, mine.base])]) {
                if (touched.has(r)) continue
                const L = level(r)
                if (!(bars[j - 1].close > L && b.low <= L + opts.touchTol * aj)) continue
                touched.add(r)
                if (b.close < L - opts.down * aj) continue   // sliced through on the touch bar: a break, not a test
                const o = bracket(bars, j, L + opts.up * aj, L - opts.down * aj, opts.horizon)
                if (o != null) list.push({ i: j, out: o })
            }
        }
        // ONE event per pullback per list (CR 2026-11-13: a falling pullback touched 38.2, 50 and 61.8% a few bars apart —
        // one move counted three times). The touched level is drawn at random (seeded), so every depth stays tested —
        // the first touch would always be the shallowest.
        for (const [own, list] of [[mine.fib, fib], [mine.base, base]]) if (own.length) list.push(own[Math.floor(rnd() * own.length)])
        lastEnd = end
        latest = { low: _round(low.price, 2), high: _round(s.price, 2), at: new Date(_ms(bars[s.i].timestamp)).toISOString() }
    }
    return { impulses, ...judge(fib, base, cut, opts), latest_impulse: latest }
}

/**
 * J. THE STOP'S ROOM, in the trader's own terms (proteus.md §8.1, 5b — 2026-11-13). His stop sits `STRUCTURE.buffer` ATR
 * under the last swing low of HIS swings (swingStructure: a zigzag of `STRUCTURE.k` ATRs, the 20-bar ATR) — not the
 * small swings the false-break count above uses. On those swing lows, from the bar after each is confirmed: every
 * break; for a stop `b` ATR under the low (`stopBuffers`), the share of breaks that reached it, and of those the share
 * that closed back over the swing low within `sweepBack` bars — STOPPED OUT, THEN BACK (a whipsaw). A break that does not
 * come back is followed for `horizon` bars for its depth. Descriptive: a
 * stop's room is a cost, measured, not a rule to beat a baseline. Pure.
 */
export function stopRoom(bars, opts = PROFILE) {
    const a = structureAtr(bars), lows = structureSwings(bars, a, STRUCTURE.k).filter(s => s.type === 'L')
    const breaks = []
    let active = [], next = 0
    for (let j = 1; j < bars.length; j++) {
        while (next < lows.length && lows[next].at < j) active.push(lows[next++])
        const broken = active.filter(l => bars[j].low < l.price)
        if (!broken.length) continue
        active = active.filter(l => !(bars[j].low < l.price))
        const s = broken.reduce((m, l) => (l.price < m.price ? l : m))
        const aj = a[j]
        if (!Number.isFinite(aj) || aj <= 0) continue
        // Back: a close over the low within `sweepBack` bars — the depth is the deepest point until then. Not back: the
        // break is followed for `horizon` bars (CR 2026-11-13: followed for 3 bars only, a low that broke and kept sliding
        // read as shallow, and the deeper stops looked safer than they are).
        let back = null, deepest = bars[j].low
        for (let k = j; k < Math.min(bars.length, j + opts.sweepBack); k++) {
            deepest = Math.min(deepest, bars[k].low)
            if (bars[k].close > s.price) { back = k; break }
        }
        if (back == null) {
            if (j + opts.horizon > bars.length) continue   // still unfolding
            for (let k = j; k < j + opts.horizon; k++) deepest = Math.min(deepest, bars[k].low)
        }
        breaks.push({ depth: (s.price - deepest) / aj, back: back != null })
    }
    const by = Object.fromEntries(opts.stopBuffers.map(b => {
        const hit = breaks.filter(x => x.depth > b)
        return [b, { stopped: hit.length, stopped_share: _round(breaks.length ? hit.length / breaks.length : null), whipsaw: _round(hit.length ? hit.filter(x => x.back).length / hit.length : null) }]
    }))
    const backDepths = breaks.filter(x => x.back).map(x => x.depth)
    return {
        swing_lows: lows.length, breaks: breaks.length, stop_buffer: STRUCTURE.buffer, followed_bars: opts.horizon,
        back_depth_atr: { median: _round(_median(backDepths), 2), p80: _round(_quantile(backDepths, 0.8), 2) },
        by_buffer: by,
    }
}

/** The bars rebuilt from the same bars in a shuffled order — each bar's move and shape kept, the sequence gone. Pure. */
function _shuffledBars(bars, rnd) {
    const parts = []
    for (let i = 1; i < bars.length; i++) {
        const p = bars[i - 1].close, b = bars[i]
        parts.push([b.close / p, b.open / p, b.high / b.close, b.low / b.close, b.volume])
    }
    for (let i = parts.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [parts[i], parts[j]] = [parts[j], parts[i]] }
    const out = [bars[0]]
    for (let i = 0; i < parts.length; i++) {
        const [cr, or, hr, lr, v] = parts[i]
        const prev = out.at(-1).close, close = prev * cr, open = prev * or
        out.push({ open, close, high: Math.max(close * hr, open, close), low: Math.min(close * lr, open, close), volume: v, timestamp: bars[i + 1].timestamp })
    }
    return out
}

/**
 * C2. IS THE FALSE-BREAK RATE THE STOCK'S, OR CHANCE'S? (Roy, 2026-11-13: "how come it's always false breaks") — a dip
 * under a 2-bar swing low closing back inside 3 bars is what NOISE does most of the time: random walks score 75–86%. So
 * the rate is compared with the same stock's bars in a shuffled order (`fbShuffles`, seeded): found on the older
 * two-thirds — `more` (it fakes more than chance: breaks of its lows tend to reverse) or `less` (they tend to follow
 * through), at z ≥ `z` and `edge` apart — and the recent third must still sit on the same side by `recentEdge`, else
 * `faded`. Otherwise `chance`: the rate is what its own moves in any order would give, and says nothing about it. Pure.
 */
export function falseBreakChance(bars, cut, fb, opts = PROFILE) {
    if (!fb?.older?.breaks || fb.older.breaks < opts.minN) return { verdict: 'thin', base: null, z: null }
    const rnd = _rng(bars.length * 104729 + Math.round(bars[0].close * 100))
    const base = []
    for (let k = 0; k < opts.fbShuffles; k++) {
        // The OLDER bars only, shuffled — the rate it is compared with is the older two-thirds' (CR 2026-11-13).
        const sb = _shuffledBars(bars.slice(0, cut), rnd)
        const r = falseBreaks(sb, calcATRSeries(_mon(sb), opts.atrPeriod), sb.length, [], opts)
        if (Number.isFinite(r.older?.false_rate)) base.push(r.older.false_rate)
    }
    if (base.length < 5) return { verdict: 'thin', base: null, z: null }
    const mean = base.reduce((a, b) => a + b, 0) / base.length
    const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / base.length)
    const diff = fb.older.false_rate - mean
    const z = sd > 0 ? diff / sd : null
    const side = Number.isFinite(z) && z >= opts.z && diff >= opts.edge ? 'more'
        : Number.isFinite(z) && z <= -opts.z && -diff >= opts.edge ? 'less' : null
    let verdict = 'chance'
    if (side) {
        const r = fb.recent?.false_rate
        const holds = fb.recent?.breaks >= opts.minRecent && Number.isFinite(r) && (side === 'more' ? r - mean >= opts.recentEdge : mean - r >= opts.recentEdge)
        verdict = holds ? side : 'faded'
    }
    return { verdict, base: _round(mean), z: _round(z, 2) }
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
    const fb = falseBreaks(bars, atrs, cut, drift, opts)

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
        false_breaks: { ...fb, chance: falseBreakChance(bars, cut, fb, opts) },
        order_blocks: orderBlockTest(bars, atrs, medAtrPct, cut, opts),
        cycle: cycleTest(bars, cut, opts),
        wyckoff: wyckoffTest(bars, atrs, cut, drift, fb.sweeps, opts),
        fib: fibPullbackTest(bars, atrs, cut, opts),
        stop_room: stopRoom(bars, opts),
        // Where the tested lines sit at the last bar — a line that HOLDS is a level the trader may anchor to (5b).
        levels_now: Object.fromEntries(Object.entries(levels).map(([k, lv]) => [k, _round(lv.at(-1), 2)])),
    }
}

const _respects = (tf) => (tf ? [
    ...Object.entries(tf.indicators).filter(([, s]) => s.verdict === 'respects').map(([k]) => k),
    ...(tf.false_breaks.after_sweep.verdict === 'respects' ? ['sweeps'] : []),
    ...(tf.order_blocks.verdict === 'respects' ? ['order_blocks'] : []),
    ...(tf.cycle?.verdict === 'respects' ? ['cycle'] : []),
    ...(tf.wyckoff?.springs?.verdict === 'respects' ? ['springs'] : []),
    ...(tf.wyckoff?.breakouts?.verdict === 'respects' ? ['range_breakouts'] : []),
    ...(tf.wyckoff?.dry_up?.verdict === 'respects' ? ['dry_up'] : []),
    ...(tf.fib?.verdict === 'respects' ? ['fib'] : []),
    ...(tf.false_breaks?.chance?.verdict === 'more' ? ['fakes'] : tf.false_breaks?.chance?.verdict === 'less' ? ['follows'] : []),
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
