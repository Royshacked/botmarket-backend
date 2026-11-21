// THE REST OF PROTEUS'S PATTERNS AS SIGNALS (Roy, 2026-11-21: "add all the indicators and patterns and rerun the grid") —
// proteus.md §10.18. Proteus reads these at the LOW and TOP of its moves (moveSteps), after the move; here each fires on
// the bar it is KNOWN at, from the bars up to that bar only:
//   - order-block touches: the engine's tight blocks (prepareSteps' touchAt — a touch counts only once the block is known)
//   - Fibonacci: the first touch from above of 38.2 / 50 / 61.8% in a pullback (fibPullbackTest's pullbacks, as §10.2)
//   - Wyckoff: a range breakout (a close over the range high — the engine's ranges), and its retest on dry volume
//   - the cycle: a dip in the window a cycle low is due (troughs confirmed 5 bars after; the mean of the last 6 gaps)
//   - double bottom / top: moveSteps' TIGHT rule, which looks 2 bars past the bar — so it fires 2 bars later
//   - candles: hammer, bullish engulfing (long); shooting star, bearish engulfing (short) — on their own bar
//   - a swept swing high (short): the engine's false break, on the MIRRORED bars
//   - the volume profile of the 120 bars before: a touch of the POC / the value-area low from above, a reclaim of the
//     VAL, a bought bar at a high- / low-volume node (long); a touch of the VAH from below, a close back under the VAH
//     after a bar over it (short)
//   - Elliott, the rules only: the pullback from the run's top an A-B-C with C within 0.618–1.618 × A, the bar the
//     pullback's low (long); the run into the bar five legs keeping the three rules, the bar the run's high (short)

import { E, P, atrsOf } from './lab-proteus.shared.mjs'
import { mirror } from './lab-proteus-signals.mjs'

const ROOT = new URL('../', import.meta.url)
const S = await import(new URL('services/moveSteps.engine.js', ROOT))

export const EXTRA = [
    { key: 'OB_BULL', label: 'OB_BULL. a bullish order block touched (tight, first touch)' },
    { key: 'FIB', label: 'FIB. the first touch of 38.2 / 50 / 61.8% in a pullback' },
    { key: 'WY_BRK', label: 'WY_BRK. a Wyckoff range breakout' },
    { key: 'WY_DRY', label: 'WY_DRY. the breakout retested on dry volume' },
    { key: 'CYCLE', label: 'CYCLE. a dip where a cycle low is due' },
    { key: 'DBL_BOT', label: 'DBL_BOT. a double bottom (tight, confirmed 2 bars on)' },
    { key: 'HAMMER', label: 'HAMMER. a hammer' },
    { key: 'ENG_UP', label: 'ENG_UP. a bullish engulfing' },
    { key: 'VP_POC', label: 'VP_POC. the volume POC touched from above' },
    { key: 'VP_VAL', label: 'VP_VAL. the value-area low touched from above' },
    { key: 'VP_RECL', label: 'VP_RECL. the value-area low reclaimed' },
    { key: 'VP_HVN', label: 'VP_HVN. a bought bar at a high-volume node' },
    { key: 'VP_LVN', label: 'VP_LVN. a bought bar at a low-volume node' },
    { key: 'EW_ABC', label: 'EW_ABC. an Elliott A-B-C pullback at its low' },
    { key: 'OB_BEAR', label: 'OB_BEAR. a bearish order block touched (SHORT)' },
    { key: 'DBL_TOP', label: 'DBL_TOP. a double top (SHORT)' },
    { key: 'STAR', label: 'STAR. a shooting star (SHORT)' },
    { key: 'ENG_DN', label: 'ENG_DN. a bearish engulfing (SHORT)' },
    { key: 'SWEPT_HI', label: 'SWEPT_HI. a swing high\'s false break, at the close back under (SHORT)' },
    { key: 'VP_VAH', label: 'VP_VAH. the value-area high touched from below (SHORT)' },
    { key: 'VP_REJ', label: 'VP_REJ. a close back under the VAH after a bar over it (SHORT)' },
    { key: 'EW_FIVE', label: 'EW_FIVE. an Elliott five-wave run at its high (SHORT)' },
]
export const EXTRA_SHORT = new Set(['OB_BEAR', 'DBL_TOP', 'STAR', 'ENG_DN', 'SWEPT_HI', 'VP_VAH', 'VP_REJ', 'EW_FIVE'])

const body = (b) => Math.abs(b.close - b.open)
const hammer = (b) => { const r = b.high - b.low; return r > 0 && Math.min(b.open, b.close) - b.low >= 2 * body(b) && b.close >= b.low + (2 / 3) * r }
const star = (b) => { const r = b.high - b.low; return r > 0 && b.high - Math.max(b.open, b.close) >= 2 * body(b) && b.close <= b.low + (1 / 3) * r }
const engulf = (prev, b, up) => (up ? b.close > b.open && prev.close < prev.open && b.close >= prev.open && b.open <= prev.close
    : b.close < b.open && prev.close > prev.open && b.close <= prev.open && b.open >= prev.close)

/** moveSteps' TIGHT double at bar j (it reads bars j−2 … j+2 — so it is KNOWN at j+2). */
function double(d, j, side, p = S.STEPS) {
    const a = d.atrs[j]
    if (!(a > 0)) return false
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

/** One series → key → [event bars], each known at its bar's close. */
export function extraEvents(bars, opts = P) {
    const n = bars.length, atrs = atrsOf(bars), cl = bars.map(b => b.close)
    const cut = Math.floor(n * (1 - opts.recentShare))
    const drift = E.driftOutcomes(bars, atrs, opts)
    const fb = E.falseBreaks(bars, atrs, cut, drift, opts)
    const wy = E.wyckoffTest(bars, atrs, cut, drift, fb.sweeps, opts)
    const d = S.prepareSteps(bars, atrs, { ranges: wy.range_list ?? [], springs: wy.spring_events ?? [] })
    const ev = Object.fromEntries(EXTRA.map(x => [x.key, []]))
    const touchFromAbove = (i, L) => i > 0 && Number.isFinite(L) && atrs[i] > 0 && bars[i - 1].close > L && bars[i].low <= L + opts.touchTol * atrs[i] && bars[i].close >= L - opts.down * atrs[i]
    const touchFromBelow = (i, L) => i > 0 && Number.isFinite(L) && atrs[i] > 0 && bars[i - 1].close < L && bars[i].high >= L - opts.touchTol * atrs[i] && bars[i].close <= L + opts.down * atrs[i]

    // Order blocks, candles, doubles.
    for (let i = 1; i < n; i++) {
        const t = d.touchAt.get(i) ?? []
        if (t.includes('bullish')) ev.OB_BULL.push(i)
        if (t.includes('bearish')) ev.OB_BEAR.push(i)
        if (hammer(bars[i])) ev.HAMMER.push(i)
        if (star(bars[i])) ev.STAR.push(i)
        if (engulf(bars[i - 1], bars[i], true)) ev.ENG_UP.push(i)
        if (engulf(bars[i - 1], bars[i], false)) ev.ENG_DN.push(i)
        if (i >= 2 && double(d, i - 2, 'low')) ev.DBL_BOT.push(i)
        if (i >= 2 && double(d, i - 2, 'high')) ev.DBL_TOP.push(i)
    }
    // Fibonacci: the first touch from above of each ratio in each pullback.
    const fib = E.fibPullbackTest(bars, atrs, cut, opts)
    for (const pb of fib.pullbacks ?? []) {
        const span = pb.high - pb.low, touched = new Set()
        for (let j = Math.max(1, pb.start); j < pb.end; j++) for (const r of opts.fibRatios) {
            const L = pb.high - r * span
            if (!touched.has(r) && touchFromAbove(j, L)) { touched.add(r); ev.FIB.push(j) }
        }
    }
    // Wyckoff: the breakout (a close over the range's high — the range's end), and the first retest of that high from
    // above within 20 bars on volume under `dryUp` × the range's average.
    for (const r of wy.range_list ?? []) {
        const u = r.until
        if (u == null || u >= n || !(cl[u] > r.high)) continue
        ev.WY_BRK.push(u)
        let vol = 0, cnt = 0
        for (let k = r.known; k <= u; k++) { vol += bars[k].volume ?? 0; cnt++ }
        const avg = cnt ? vol / cnt : 0
        for (let k = u + 1; k < Math.min(n, u + 21); k++) {
            if (touchFromAbove(k, r.high)) { if (avg > 0 && (bars[k].volume ?? 0) < opts.dryUp * avg) ev.WY_DRY.push(k); break }
        }
    }
    // The cycle: closing troughs (the lowest close of 5 bars each side), each known 5 bars after; at bar i, with ≥ 6 known
    // troughs, the mean of the last 6 gaps; a dip (the lowest close of the last 5 bars) inside ±15% of that gap from the
    // last trough.
    const L = opts.cycleLookback, troughs = []
    for (let i = 0; i < n; i++) {
        const t = i - L
        if (t >= L) {
            let low = true
            for (let k = t - L; k <= t + L && low; k++) if (k !== t && cl[k] <= cl[t]) low = false
            if (low) troughs.push(t)
        }
        if (troughs.length >= 7) {
            const last = troughs.slice(-7), gaps = last.slice(1).map((x, k) => x - last[k])
            const m = gaps.reduce((s, x) => s + x, 0) / gaps.length, since = i - last.at(-1)
            const dip = cl[i] <= Math.min(...cl.slice(Math.max(0, i - 4), i + 1))
            if (since >= 0.85 * m && since <= 1.15 * m && dip) ev.CYCLE.push(i)
        }
    }
    // Swept highs: the engine's false breaks on the mirrored bars.
    for (const s of E.falseBreaks(mirror(bars), atrs, cut, E.driftOutcomes(mirror(bars), atrs, opts), opts).sweeps) ev.SWEPT_HI.push(s.i)
    // The volume profile of the 120 bars before each bar.
    for (let i = S.STEPS.vpBars + 1; i < n; i++) {
        const vp = S.volumeProfile(bars, i)
        if (!vp) continue
        const b = bars[i], up = b.close > b.open
        if (touchFromAbove(i, vp.poc)) ev.VP_POC.push(i)
        if (touchFromAbove(i, vp.val)) ev.VP_VAL.push(i)
        if (bars[i - 1].close < vp.val && b.close > vp.val) ev.VP_RECL.push(i)
        if (up && vp.level(b.low) >= S.STEPS.hvn) ev.VP_HVN.push(i)
        if (up && vp.level(b.low) != null && vp.level(b.low) <= S.STEPS.lvn) ev.VP_LVN.push(i)
        if (touchFromBelow(i, vp.vah)) ev.VP_VAH.push(i)
        if (bars[i - 1].close > vp.vah && b.close < vp.vah) ev.VP_REJ.push(i)
    }
    // Elliott — the rules only. A-B-C: the bar the pullback's low since the run's top (runOf). Five waves: the bar the
    // run's high since its low (the lowest close of the 60 bars before).
    for (let i = 130; i < n; i++) {
        const run = S.runOf(cl, i)
        if (run && cl[i] <= Math.min(...cl.slice(run.h, i)) && S.abcPullback(cl, atrs, run.h, i)) ev.EW_ABC.push(i)
        let lo = i - 60
        for (let j = i - 60; j < i; j++) if (cl[j] < cl[lo]) lo = j
        if (cl[i] >= Math.max(...cl.slice(lo, i)) && S.fiveWaves(cl, atrs, lo, i)) ev.EW_FIVE.push(i)
    }
    return ev
}

