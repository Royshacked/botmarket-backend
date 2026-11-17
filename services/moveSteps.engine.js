// M. WHAT SITS AT EVERY STEP OF A MOVE (docs/design/proteus.md §10.11, Roy 2026-11-17: "I prefer to check patterns /
// OBs / indicators at all move steps — in time I'll see if to take it off. Also we tried it only on daily charts. Also
// — can we add volume profile and Elliott waves?"). §10.7's lab checks (scripts/lab-proteus-moves-patterns.mjs, daily
// only, 11 names) on every name and every timeframe, with the TIGHT order block and double bottom/top, plus a volume
// profile and Elliott's measurable rules. PURE: bars in, numbers out.
//
// The moves and their steps are K's (movesProfile): the LOW a move starts at, the TOP it pulled back from, the run INTO
// the top. Every fact is read against ANY LOW (the same fact at every local low, its top and run found the same way —
// a move starts at a low by construction): a fact on most moves means nothing when it is on most lows (the lab's loose
// detectors fired on 30%+ of any bar).

import { calcSMASeries, calcEMASeries, calcRSISeries, calcMACDSeries } from '../monitoring/evaluators/structured.evaluator.js'
import { swings, detectOrderBlocks } from './smc.engine.js'

/** M's rules, fixed before the run (§10.11). */
export const STEPS = Object.freeze({
    look: 60,                                   // the top: the highest close of the 60 bars before the low (K's)
    near: 3,                                    // a fact "at" a bar: within 3 bars of it
    swingLookback: 2, sweepBack: 3,             // a swept swing: taken out and closed back within 3 bars
    obAge: 120, obDisplace: 1.5, obWidth: 1.5, obSlack: 0.5,   // the TIGHT order block, its FIRST touch
    fibBand: 5, at200: 0.5, divFrom: 40, divTo: 5,
    dbTol: 0.25, dbFrom: 15, dbTo: 60, dbRise: 3,               // the TIGHT double bottom / top
    intoBars: 20,                               // into the top: the 20 bars up to it
    vpBars: 120, vpBins: 40, vpArea: 0.7, vpNear: 0.5, hvn: 1.5, lvn: 0.5,   // the volume profile
    ewTurn: 1.5, ewCMin: 0.618, ewCMax: 1.618,  // Elliott: a turn needs a 1.5 ATR reversal; C within 0.618–1.618 × A
    localLow: 5,                                // the base: every local low (the lowest close of 5 bars each side) …
    baseMax: 1500,                              // … at most this many sampled
    shuffles: 4,                                // the second baseline: the moves of its bars in 4 shuffled orders
    minMoves: 10, minRecent: 3, edge: 0.10, recentEdge: 0.05, z: 3,   // stands out: Proteus's own edge / z / recent check
})

/** The facts, per step, in words — what the row and the tool text say. */
export const STEP_WORDS = Object.freeze({
    low: {
        bull_ob: 'a bullish order block (first touch)', swept_low: 'a swept swing low', spring: 'a Wyckoff spring', in_range: 'inside a Wyckoff range',
        fib: 'a 38.2/50/61.8% retrace', at_200: 'at the 200 SMA', macd_under_0: 'MACD under zero', hist_turn: 'the MACD histogram turning up',
        macd_cross_up: 'a MACD cross up', rsi_div: 'RSI bullish divergence', macd_div: 'MACD bullish divergence', double_bottom: 'a double bottom',
        hammer: 'a hammer', bull_engulf: 'a bullish engulfing',
        vp_poc: 'at the volume POC', vp_val: 'at the value-area low', vp_under: 'under the value area', vp_hvn: 'at a high-volume node', vp_lvn: 'at a low-volume node',
        ew_abc: 'an Elliott A-B-C pullback',
    },
    top: {
        bear_ob: 'a bearish order block (first touch)', swept_high: 'a swept swing high', macd_cross_down: 'a MACD cross down', rsi_div: 'RSI bearish divergence',
        macd_div: 'MACD bearish divergence', double_top: 'a double top', shooting_star: 'a shooting star', bear_engulf: 'a bearish engulfing',
        vp_poc: 'at the volume POC', vp_vah: 'at the value-area high', vp_over: 'over the value area', vp_hvn: 'at a high-volume node', vp_lvn: 'at a low-volume node',
    },
    into: {
        wyckoff_breakout: 'a Wyckoff range breakout', bull_ob_retest: 'a bullish order block retested', swept_low: 'a swept swing low', macd_over_0: 'MACD over zero',
        macd_cross_up: 'a MACD cross up', stacked: 'the 20 EMA over the 50 SMA', rsi_over_60: 'RSI over 60', ew_five: 'an Elliott five-wave run',
    },
})
export const STEP_NAMES = Object.freeze({ low: 'at the low', top: 'at the top', into: 'into the top' })

const fin = Number.isFinite
const _etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const _round = (x, d = 3) => (fin(x) ? Math.round(x * 10 ** d) / 10 ** d : null)
const anyIn = (from, to, f) => { for (let j = Math.max(1, from); j <= to; j++) if (f(j)) return true; return false }

/** The top a low at `s` pulled back from, and the low its run began at (K's rule). Null without room. Pure. */
export function runOf(closes, s, look = STEPS.look) {
    if (s < look * 2) return null
    let h = s - look
    for (let j = s - look; j < s; j++) if (closes[j] > closes[h]) h = j
    let lo = h - look
    for (let j = h - look; j < h; j++) if (closes[j] < closes[lo]) lo = j
    return lo < 0 ? null : { h, lo }
}

/** Everything the facts read, once per series. `wyckoff` — the engine's ranges and springs. Pure. */
export function prepareSteps(bars, atrs, { ranges = [], springs = [] } = {}, p = STEPS) {
    const n = bars.length, cl = bars.map(b => b.close)
    const at = new Map(bars.map((b, i) => [b.timestamp, i]))
    // Order blocks, TIGHT (§10.7): displaced ≥ 1.5 ATR three bars on, a zone ≤ 1.5 ATR, and only the FIRST touch after
    // it was known (its impulse + 2 bars) — found once, so a bar's check is a lookup.
    const touchAt = new Map()
    for (const o of detectOrderBlocks(bars)) {
        const i = at.get(o.at), known = at.get(o.impulseAt) + 2
        if (i == null || !fin(known)) continue
        const a = atrs[i], after = cl[i + 3]
        if (!fin(a) || a <= 0 || after == null || o.top - o.bottom > p.obWidth * a) continue
        if (o.type === 'bullish' ? after < o.top + p.obDisplace * a : after > o.bottom - p.obDisplace * a) continue
        for (let k = known; k < n && k - i <= p.obAge; k++) {
            if (o.type === 'bullish' ? bars[k].low <= o.top : bars[k].high >= o.bottom) {
                const reach = o.type === 'bullish' ? bars[k].low >= o.bottom - p.obSlack * atrs[k] : bars[k].high <= o.top + p.obSlack * atrs[k]
                if (reach) { if (!touchAt.has(k)) touchAt.set(k, []); touchAt.get(k).push(o.type) }
                break
            }
        }
    }
    // The last swing low / high known by each bar (confirmed `swingLookback` bars after it).
    const sw = swings(bars, p.swingLookback)
    const lastKnown = (type) => {
        const out = new Array(n).fill(null), list = sw.filter(s => s.type === type)
        let k = -1
        for (let j = 0; j < n; j++) {
            while (k + 1 < list.length && list[k + 1].i + p.swingLookback < j) k++
            out[j] = k >= 0 ? list[k] : null
        }
        return { out, at: new Set(list.map(s => s.i)) }
    }
    const lows = lastKnown('low'), highs = lastKnown('high')
    const macd = calcMACDSeries(cl)
    return {
        bars, cl, atrs, touchAt, lows, highs, ranges, springs,
        s200: calcSMASeries(cl, 200), s50: calcSMASeries(cl, 50), e20: calcEMASeries(cl, 20), rsi: calcRSISeries(cl, 14),
        line: macd.line, signal: macd.signal, hist: macd.hist,
    }
}

const crossUp = (d, j) => fin(d.line[j]) && fin(d.signal[j]) && fin(d.line[j - 1]) && fin(d.signal[j - 1]) && d.line[j - 1] <= d.signal[j - 1] && d.line[j] > d.signal[j]
const crossDown = (d, j) => fin(d.line[j]) && fin(d.signal[j]) && fin(d.line[j - 1]) && fin(d.signal[j - 1]) && d.line[j - 1] >= d.signal[j - 1] && d.line[j] < d.signal[j]
const block = (d, j, type) => (d.touchAt.get(j) ?? []).includes(type)

function swept(d, j, side, p = STEPS) {
    const prior = (side === 'low' ? d.lows : d.highs).out[j]
    if (!prior) return false
    const b = d.bars[j]
    if (side === 'low' ? !(b.low < prior.price) : !(b.high > prior.price)) return false
    for (let k = j; k < Math.min(d.bars.length, j + p.sweepBack); k++) if (side === 'low' ? d.cl[k] > prior.price : d.cl[k] < prior.price) return true
    return false
}

function divergence(d, j, series, side, p = STEPS) {
    let k = null
    for (let m = j - p.divFrom; m <= j - p.divTo; m++) if (m >= 0 && (k == null || (side === 'low' ? d.cl[m] < d.cl[k] : d.cl[m] > d.cl[k]))) k = m
    if (k == null || !fin(series[j]) || !fin(series[k])) return false
    return side === 'low' ? d.cl[j] < d.cl[k] && series[j] > series[k] : d.cl[j] > d.cl[k] && series[j] < series[k]
}

/** TIGHT double: bar j a 2-bar extreme, a swing 15–60 bars before within 0.25 ATR, ≥ 3 ATR between. Pure. */
function double(d, j, side, p = STEPS) {
    const a = d.atrs[j]
    if (!fin(a)) return false
    const px = (m) => (side === 'low' ? d.bars[m].low : d.bars[m].high)
    const better = (x, y) => (side === 'low' ? x < y : x > y)
    for (let k = j - 2; k <= j + 2; k++) if (k !== j && k >= 0 && k < d.bars.length && !better(px(j), px(k))) return false
    const swingsAt = (side === 'low' ? d.lows : d.highs).at
    for (let m = j - p.dbTo; m <= j - p.dbFrom; m++) {
        if (m < 0 || !swingsAt.has(m) || Math.abs(px(m) - px(j)) > p.dbTol * a) continue
        let ext = side === 'low' ? -Infinity : Infinity
        for (let k = m + 1; k < j; k++) ext = side === 'low' ? Math.max(ext, d.bars[k].high) : Math.min(ext, d.bars[k].low)
        if (side === 'low' ? ext - px(j) >= p.dbRise * a : px(j) - ext >= p.dbRise * a) return true
    }
    return false
}

const body = (b) => Math.abs(b.close - b.open)
const hammer = (b) => { const r = b.high - b.low; return r > 0 && Math.min(b.open, b.close) - b.low >= 2 * body(b) && b.close >= b.low + (2 / 3) * r }
const star = (b) => { const r = b.high - b.low; return r > 0 && b.high - Math.max(b.open, b.close) >= 2 * body(b) && b.close <= b.low + (1 / 3) * r }
const engulf = (prev, b, up) => (up ? b.close > b.open && prev.close < prev.open && b.close >= prev.open && b.open <= prev.close
    : b.close < b.open && prev.close > prev.open && b.close <= prev.open && b.open >= prev.close)

/**
 * THE VOLUME PROFILE of the `vpBars` bars before bar j: each bar's volume spread evenly over its high–low across
 * `vpBins` price bins → `{ poc, val, vah, level(price) }` (level: the bin's volume against the average bin), or null
 * (no volume / no range). The value area grows from the POC to the busier side until it holds 70% of the volume. Pure.
 */
export function volumeProfile(bars, j, p = STEPS) {
    const from = Math.max(0, j - p.vpBars)
    if (j - from < p.vpBars / 2) return null
    let lo = Infinity, hi = -Infinity
    for (let k = from; k < j; k++) { lo = Math.min(lo, bars[k].low); hi = Math.max(hi, bars[k].high) }
    if (!(hi > lo)) return null
    const step = (hi - lo) / p.vpBins, vol = new Array(p.vpBins).fill(0)
    const binOf = (x) => Math.min(p.vpBins - 1, Math.max(0, Math.floor((x - lo) / step)))
    let total = 0
    for (let k = from; k < j; k++) {
        const v = bars[k].volume ?? 0
        if (!(v > 0)) continue
        const b0 = binOf(bars[k].low), b1 = binOf(bars[k].high)
        for (let b = b0; b <= b1; b++) vol[b] += v / (b1 - b0 + 1)
        total += v
    }
    if (!(total > 0)) return null
    let poc = 0
    for (let b = 1; b < vol.length; b++) if (vol[b] > vol[poc]) poc = b
    let a = poc, z = poc, inside = vol[poc]
    while (inside < p.vpArea * total && (a > 0 || z < vol.length - 1)) {
        const down = a > 0 ? vol[a - 1] : -1, up = z < vol.length - 1 ? vol[z + 1] : -1
        if (up >= down) inside += vol[++z]; else inside += vol[--a]
    }
    const mean = total / p.vpBins, mid = (b) => lo + (b + 0.5) * step
    return {
        poc: mid(poc), val: lo + a * step, vah: lo + (z + 1) * step,
        level: (x) => (x < lo || x > hi ? null : vol[binOf(x)] / mean),
    }
}

function vpFacts(d, j, price, side, p = STEPS) {
    const vp = volumeProfile(d.bars, j, p), a = d.atrs[j]
    if (!vp || !fin(a) || a <= 0) return {}
    const lvl = vp.level(price)
    const edge = side === 'low' ? vp.val : vp.vah
    return {
        vp_poc: Math.abs(price - vp.poc) <= p.vpNear * a,
        [side === 'low' ? 'vp_val' : 'vp_vah']: Math.abs(price - edge) <= p.vpNear * a,
        [side === 'low' ? 'vp_under' : 'vp_over']: side === 'low' ? price < vp.val : price > vp.vah,
        vp_hvn: lvl != null && lvl >= p.hvn,
        vp_lvn: lvl != null && lvl <= p.lvn,
    }
}

/**
 * ELLIOTT'S TURNS — a zigzag on the closes from `from` to `to`, heading `dir` (+1 up / −1 down) first: a turn is the
 * extreme close before a reversal of ≥ `ewTurn` ATR. Both ends are turns. → the turns' bar indexes. Pure.
 */
export function zigzag(closes, atrs, from, to, dir, p = STEPS) {
    const out = [from]
    let ext = from
    for (let j = from + 1; j <= to; j++) {
        const a = atrs[ext]
        if (dir > 0 ? closes[j] > closes[ext] : closes[j] < closes[ext]) { ext = j; continue }
        if (fin(a) && a > 0 && Math.abs(closes[ext] - closes[j]) >= p.ewTurn * a) { out.push(ext); dir = -dir; ext = j }
    }
    // The last leg ends at `to`: when `to` still lies the way the open leg heads, it IS that leg's end; when the price
    // came back past it, the leg's extreme was a turn (short of the threshold, so a count of these fails honestly).
    const last = out.at(-1)
    if (last !== to) {
        if ((closes[to] - closes[last]) * dir <= 0 && ext !== last && ext !== to) out.push(ext)
        out.push(to)
    }
    return out
}

/** The run (low → top) as FIVE legs keeping Elliott's three rules: 2 never under 1's start, 3 not the shortest, 4 never into 1. Pure. */
export function fiveWaves(closes, atrs, lo, h, p = STEPS) {
    const t = zigzag(closes, atrs, lo, h, 1, p)
    if (t.length !== 6) return false
    const v = t.map(i => closes[i])
    if (!(v[1] > v[0] && v[2] < v[1] && v[3] > v[2] && v[4] < v[3] && v[5] > v[4])) return false
    const w1 = v[1] - v[0], w3 = v[3] - v[2], w5 = v[5] - v[4]
    return v[2] > v[0] && w3 > Math.min(w1, w5) && v[4] > v[1]
}

/** The pullback (top → low) as THREE legs, A down, B up, C down past A's end, C within 0.618–1.618 × A. Pure. */
export function abcPullback(closes, atrs, h, s, p = STEPS) {
    const t = zigzag(closes, atrs, h, s, -1, p)
    if (t.length !== 4) return false
    const v = t.map(i => closes[i])
    const A = v[0] - v[1], B = v[2] - v[1], C = v[2] - v[3]
    return A > 0 && B > 0 && v[2] < v[0] && v[3] < v[1] && C >= p.ewCMin * A && C <= p.ewCMax * A
}

/** The facts of one low `s` (its top `h`, its run from `lo`), per step. Pure. */
export function stepFacts(d, s, h, lo, p = STEPS) {
    const n = d.bars.length, a = d.atrs[s], from = s - p.near
    let runLow = Infinity
    for (let j = Math.max(0, h - p.look); j < h; j++) runLow = Math.min(runLow, d.cl[j])
    const depth = d.cl[h] > runLow ? (d.cl[h] - d.cl[s]) / (d.cl[h] - runLow) * 100 : null
    const low = {
        bull_ob: anyIn(from, s, j => block(d, j, 'bullish')),
        swept_low: anyIn(from, s, j => swept(d, j, 'low', p)),
        spring: d.springs.some(sp => sp.dip >= from && sp.dip <= s),
        in_range: d.ranges.some(r => r.known <= s && s <= r.until),
        fib: depth != null && [38.2, 50, 61.8].some(f => Math.abs(depth - f) <= p.fibBand),
        at_200: fin(d.s200[s]) && fin(a) && anyIn(from, s, j => fin(d.s200[j]) && Math.abs(d.bars[j].low - d.s200[j]) <= p.at200 * a),
        macd_under_0: fin(d.line[s]) && d.line[s] < 0,
        hist_turn: fin(d.hist[s]) && fin(d.hist[s - 1]) && d.hist[s] > d.hist[s - 1],
        macd_cross_up: anyIn(from, Math.min(n - 1, s + p.near), j => crossUp(d, j)),
        rsi_div: divergence(d, s, d.rsi, 'low', p), macd_div: divergence(d, s, d.line, 'low', p),
        double_bottom: anyIn(from, s, j => double(d, j, 'low', p)),
        // Each candle on its own: a bullish engulfing is common at any low (an up bar after the red bar that made it).
        hammer: anyIn(s, Math.min(n - 1, s + 1), j => hammer(d.bars[j])),
        bull_engulf: anyIn(s, Math.min(n - 1, s + 1), j => engulf(d.bars[j - 1], d.bars[j], true)),
        ...vpFacts(d, s, d.bars[s].low, 'low', p),
        ew_abc: abcPullback(d.cl, d.atrs, h, s, p),
    }
    const tFrom = h - p.near, tTo = Math.min(n - 1, h + p.near)
    const top = {
        bear_ob: anyIn(tFrom, tTo, j => block(d, j, 'bearish')),
        swept_high: anyIn(tFrom, tTo, j => swept(d, j, 'high', p)),
        macd_cross_down: anyIn(h, Math.min(n - 1, h + 5), j => crossDown(d, j)),
        rsi_div: anyIn(tFrom, h, j => divergence(d, j, d.rsi, 'high', p)), macd_div: anyIn(tFrom, h, j => divergence(d, j, d.line, 'high', p)),
        double_top: anyIn(tFrom, tTo, j => double(d, j, 'high', p)),
        shooting_star: anyIn(h, Math.min(n - 1, h + 1), j => star(d.bars[j])),
        bear_engulf: anyIn(h, Math.min(n - 1, h + 1), j => engulf(d.bars[j - 1], d.bars[j], false)),
        ...vpFacts(d, h, d.bars[h].high, 'high', p),
    }
    const iFrom = Math.max(1, h - p.intoBars)
    const into = {
        wyckoff_breakout: d.ranges.some(r => r.until >= iFrom && r.until <= h && d.cl[r.until] > r.high),
        bull_ob_retest: anyIn(iFrom, h, j => block(d, j, 'bullish')),
        swept_low: anyIn(iFrom, h, j => swept(d, j, 'low', p)),
        macd_over_0: fin(d.line[h]) && d.line[h] > 0,
        macd_cross_up: anyIn(Math.max(1, h - 10), h, j => crossUp(d, j)),
        stacked: fin(d.e20[h]) && fin(d.s50[h]) && d.e20[h] > d.s50[h],
        rsi_over_60: fin(d.rsi[h]) && d.rsi[h] > 60,
        ew_five: fiveWaves(d.cl, d.atrs, lo, h, p),
    }
    return { low, top, into }
}

/**
 * One timeframe's STEPS: `moves` — K's rows `{ i (the low), h, lo, recent }`; `cut` — the recent third's first bar;
 * `shuffled` — the same name's bars in shuffled orders with their own moves (`{ bars, atrs, moves, wyckoff }`, the
 * engine's). Per step, per fact, against TWO baselines — its other lows, and the moves of its shuffled bars (a fact that
 * comes with any move is on those too) — a verdict: 'stands_out' (older ≥ each + edge at z ≥ 3, the recent ≥ each +
 * recentEdge), 'rarer' (the mirror), 'faded' (older only, the recent did not keep it), 'unconfirmed' (too few recent),
 * 'no', or 'thin' (under `minMoves` moves). Pure.
 */
export function stepsProfile(bars, atrs, moves, cut, wyckoff = {}, { session = false, shuffled = [] } = {}, p = STEPS) {
    if (!Array.isArray(moves) || !moves.length) return null
    const d = prepareSteps(bars, atrs, wyckoff, p)
    const rows = moves.map(m => ({ recent: m.recent, f: stepFacts(d, m.i, m.h, m.lo, p) }))
    // Any LOW: a move's start is a low by construction (the lowest close of its run), so the base is every local low —
    // the lowest close of `localLow` bars each side — its top and run found by K's rule; sampled to `baseMax`. (Any bar,
    // the first try, made the low's own traits look like the moves': MACD histogram still falling at 0% vs 51%.) On
    // session-only timeframes the neighbours are the same session's, as a move's are (KO 5-minute: 14 of 61 starts were
    // not the lowest of the 5 bars before — those were the session before's; the MACD histogram then "stood out").
    const day = session ? bars.map(b => _etDay.format(new Date(b.timestamp < 1e12 ? b.timestamp * 1000 : b.timestamp))) : null
    const first = p.look * 2, lows = []
    for (let j = Math.max(first, p.localLow); j < bars.length - p.localLow; j++) {
        let isLow = true
        for (let k = j - p.localLow; k <= j + p.localLow && isLow; k++) if (k !== j && (!day || day[k] === day[j]) && d.cl[k] <= d.cl[j]) isLow = false
        if (isLow) lows.push(j)
    }
    const stride = Math.max(1, Math.ceil(lows.length / p.baseMax)), base = []
    for (let q = 0; q < lows.length; q += stride) {
        const j = lows[q], r = runOf(d.cl, j, p.look)
        if (r && fin(atrs[j]) && atrs[j] > 0) base.push({ recent: j >= cut, f: stepFacts(d, j, r.h, r.lo, p) })
    }
    const noise = shuffled.flatMap(x => {
        const dx = prepareSteps(x.bars, x.atrs, x.wyckoff, p)
        return x.moves.map(m => ({ recent: m.recent, f: stepFacts(dx, m.i, m.h, m.lo, p) }))
    })
    const share = (list, step, k) => (list.length ? list.filter(x => x.f[step][k] === true).length / list.length : null)
    const split = (list) => [list.filter(x => !x.recent), list.filter(x => x.recent)]
    const [older, recent] = split(rows), [bOld, bNew] = split(base), [nOld, nNew] = split(noise)
    // z of the older moves' share against a baseline share; a baseline of 0 or 1 is floored to half an event.
    const zOf = (o, b, nb) => {
        if (o == null || b == null || !nb) return null
        const q = Math.min(Math.max(b, 0.5 / nb), 1 - 0.5 / nb)
        return (o - q) / Math.sqrt(q * (1 - q) / older.length)
    }
    const out = { moves: rows.length, other_lows: base.length, shuffled_moves: noise.length }
    for (const step of Object.keys(STEP_WORDS)) {
        out[step] = {}
        for (const k of Object.keys(STEP_WORDS[step])) {
            const o = share(older, step, k), r = share(recent, step, k)
            const ao = share(bOld, step, k), ar = share(bNew, step, k), so = share(nOld, step, k), sr = share(nNew, step, k)
            const za = zOf(o, ao, bOld.length), zs = zOf(o, so, nOld.length)
            let verdict = 'no'
            if (rows.length < p.minMoves || o == null) verdict = 'thin'
            else {
                // Beats a baseline: `dir` +1 over it, −1 under it; a missing baseline (no shuffles) is not held against it.
                const beats = (b, z, dir) => b == null || (dir * (o - b) >= p.edge && dir * z >= p.z)
                const up = ao != null && beats(ao, za, 1) && beats(so, zs, 1), down = ao != null && beats(ao, za, -1) && beats(so, zs, -1)
                if (up || down) {
                    const dir = up ? 1 : -1
                    const keeps = (b) => b == null || dir * (r - b) >= p.recentEdge
                    if (recent.length < p.minRecent || r == null || ar == null) verdict = 'unconfirmed'
                    else if (keeps(ar) && keeps(sr ?? so)) verdict = up ? 'stands_out' : 'rarer'
                    else verdict = 'faded'
                }
            }
            // Compact — the stored profile is kept per name (Atlas quota); `stepFact` names the fields.
            out[step][k] = [_round(o, 2), _round(r, 2), _round(ao, 2), _round(ar, 2), _round(so, 2), _round(sr, 2), _round(za, 1), _round(zs, 1), verdict]
        }
    }
    return out
}

/** One stored fact → its named fields (null for none). Pure. */
export const stepFact = (f) => (Array.isArray(f)
    ? { older: f[0], recent: f[1], any_older: f[2], any_recent: f[3], shuffled_older: f[4], shuffled_recent: f[5], z: f[6], z_shuffled: f[7], verdict: f[8] }
    : null)
