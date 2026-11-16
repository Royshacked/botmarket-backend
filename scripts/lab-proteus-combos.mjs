#!/usr/bin/env node
// TEN COMBINATIONS (Roy, 2026-11-16: "combinations of patterns and indicators and both … pick 10"). Declared in
// docs/design/proteus.md §10.2 before the run. Each combination against Part A alone, Part B alone and the drift — the
// weakest verdict counts — per name on the screener's daily bars and pooled over daily and 5-minute, with every series
// shuffled through the identical pipeline beside it.
//
//   node --max-old-space-size=6000 scripts/lab-proteus-combos.mjs   → data/lab/proteus-combos.out.txt

import fs from 'fs'
import { E, P, atrsOf, calcSMASeries, calcEMASeries, calcRSISeries, calcMACDSeries, seedOf, weakest, dailyNames, fiveMinuteWeeks, makeTally, report } from './lab-proteus.shared.mjs'

export const TESTS = [
    { key: 'c1', label: '1. T50 + UP200 — a pullback to the 50 in an uptrend' },
    { key: 'c2', label: '2. T20 + STACK — a pullback to the 20 in a stacked trend' },
    { key: 'c3', label: '3. T200 + VOL — the 200 tested on heavy volume' },
    { key: 'c4', label: '4. any MA touch on a VUP bar — a touch closing up on 2× volume' },
    { key: 'c5', label: '5. SWEEP + VOL on the break or reclaim bar — stops run on volume' },
    { key: 'c6', label: '6. SWEEP + UP200 — a sweep in an uptrend' },
    { key: 'c7', label: '7. RSI30 + UP200 — oversold in an uptrend' },
    { key: 'c8', label: '8. MACD↑ under the zero line — the turn from a decline' },
    { key: 'c9', label: '9. FIB within 0.25 ATR of the 20 EMA or 50 SMA — two levels agree' },
    { key: 'c10', label: '10. SPRING on light volume' },
]

/** One series → per combination { event, A, B } outcome lists (the engine's one outcome), plus the drift. Pure. */
export function combos(bars, opts = P) {
    const n = bars.length
    const atrs = atrsOf(bars)
    const cut = Math.floor(n * (1 - opts.recentShare))
    const closes = bars.map(b => b.close)
    const drift = E.driftOutcomes(bars, atrs, opts)
    const fb = E.falseBreaks(bars, atrs, cut, drift, opts)
    const wy = E.wyckoffTest(bars, atrs, cut, drift, fb.sweeps, opts)
    const fib = E.fibPullbackTest(bars, atrs, cut, opts)
    const ema20 = calcEMASeries(closes, 20), sma50 = calcSMASeries(closes, 50), sma200 = calcSMASeries(closes, 200)
    const vol20 = calcSMASeries(bars.map(b => b.volume ?? 0), 20)
    const rsi = calcRSISeries(closes, 14)
    const { line, signal } = calcMACDSeries(closes)

    const touchSet = (lv) => new Set(E.levelTouches(bars, lv, atrs, opts).map(e => e.i))
    const T20 = touchSet(ema20), T50 = touchSet(sma50), T200 = touchSet(sma200)
    const up200 = (i) => Number.isFinite(sma200[i]) && closes[i] > sma200[i]
    const stack = (i) => Number.isFinite(sma200[i]) && ema20[i] > sma50[i] && sma50[i] > sma200[i]
    const vol = (i) => i >= 1 && vol20[i - 1] > 0 && (bars[i].volume ?? 0) >= opts.rvol * vol20[i - 1]
    const vup = (i) => vol(i) && bars[i].close > bars[i].open
    const anyT = (i) => T20.has(i) || T50.has(i) || T200.has(i)
    const sweepAt = new Map(fb.sweeps.map(s => [s.i, s]))
    const rsi30 = (i) => rsi[i - 1] != null && rsi[i - 1] >= opts.rsiLow && rsi[i] < opts.rsiLow
    const macdUp = (i) => line[i - 1] != null && signal[i - 1] != null && line[i - 1] <= signal[i - 1] && line[i] > signal[i]
    const macdNeg = (i) => line[i] != null && line[i] < 0

    // FIB touches: the first touch from above of each ratio in each pullback (fibPullbackTest's rule), with the level.
    const fibAt = new Map()
    for (const pb of fib.pullbacks) {
        const span = pb.high - pb.low, touched = new Set()
        for (let j = Math.max(1, pb.start); j < pb.end; j++) {
            const a = atrs[j]
            if (!Number.isFinite(a) || a <= 0) continue
            for (const r of opts.fibRatios) {
                const L = pb.high - r * span
                if (touched.has(r) || !(bars[j - 1].close > L && bars[j].low <= L + opts.touchTol * a)) continue
                touched.add(r)
                if (!fibAt.has(j)) fibAt.set(j, L)
            }
        }
    }
    const fibNearMa = (i) => {
        const L = fibAt.get(i), a = atrs[i]
        return L != null && [ema20[i], sma50[i]].some(m => Number.isFinite(m) && Math.abs(L - m) <= opts.touchTol * a)
    }
    // Springs: light (the dip bar on low volume) or not; ordinary sweeps = sweeps that are not springs (the engine's rule).
    const springAt = new Map(wy.spring_events.map(s => [s.i, s]))
    const notSpring = (i) => !wy.spring_events.some(sp => Math.abs(sp.i - i) <= opts.sweepBack)

    const ev = (pred) => E.eventOutcomes(bars, atrs, pred, opts)
    // [event, part A alone, part B alone] — each part without the combination's own bars.
    const def = {
        c1: [i => T50.has(i) && up200(i), i => T50.has(i) && !up200(i) && Number.isFinite(sma200[i]), i => up200(i) && !T50.has(i)],
        c2: [i => T20.has(i) && stack(i), i => T20.has(i) && !stack(i) && Number.isFinite(sma200[i]), i => stack(i) && !T20.has(i)],
        c3: [i => T200.has(i) && vol(i), i => T200.has(i) && !vol(i), i => vol(i) && !T200.has(i)],
        c4: [i => anyT(i) && vup(i), i => anyT(i) && !vup(i), i => vup(i) && !anyT(i)],
        c5: [i => sweepAt.has(i) && (vol(i) || vol(sweepAt.get(i).at)), i => sweepAt.has(i) && !(vol(i) || vol(sweepAt.get(i).at)), i => vol(i) && !sweepAt.has(i)],
        c6: [i => sweepAt.has(i) && up200(i), i => sweepAt.has(i) && !up200(i) && Number.isFinite(sma200[i]), i => up200(i) && !sweepAt.has(i)],
        c7: [i => rsi30(i) && up200(i), i => rsi30(i) && !up200(i) && Number.isFinite(sma200[i]), i => up200(i) && !rsi30(i)],
        c8: [i => macdUp(i) && macdNeg(i), i => macdUp(i) && !macdNeg(i), i => macdNeg(i) && !macdUp(i)],
        c9: [i => fibNearMa(i), i => fibAt.has(i) && !fibNearMa(i), i => (T20.has(i) || T50.has(i)) && !fibAt.has(i)],
        c10: [i => springAt.get(i)?.light === true, i => springAt.get(i)?.light === false, i => sweepAt.has(i) && notSpring(i)],
    }
    const out = {}
    for (const [k, [e, a, b]] of Object.entries(def)) out[k] = { event: ev(e), A: ev(a), B: ev(b) }
    return { out, drift, cut }
}

function run(tally, side, sym, bars, perName) {
    const { out, drift, cut } = combos(bars)
    for (const t of TESTS) {
        const g = out[t.key]
        if (perName) tally.verdict(t.key, side, weakest([E.judge(g.event, g.A, cut).verdict, E.judge(g.event, g.B, cut).verdict, E.judge(g.event, drift, cut).verdict]), sym)
        tally.pool(t.key, side, 'event', bars, g.event)
        tally.pool(t.key, side, 'A', bars, g.A)
        tally.pool(t.key, side, 'B', bars, g.B)
        tally.pool(t.key, side, 'drift', bars, drift)
    }
}

if (process.argv[1]?.endsWith('lab-proteus-combos.mjs')) {   // run, not imported (the unit test imports it)
    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    say(`# Ten combinations (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.2, PROFILE as built (z ${P.z}, edge ${P.edge}, horizon ${P.horizon})`)

    const day = makeTally()
    let names = 0
    for (const [sym, bars] of dailyNames()) {
        run(day, 'real', sym, bars, true)
        run(day, 'shuf', sym, E.shuffledBars(bars, E.seededRandom(seedOf(sym))), true)
        if (++names % 100 === 0) console.log(`  daily ${names}`)
    }
    say(`\n## Daily — ${names} names, ~4 years each (2022-09 → 2026-10); pooled split at 2026-03-01`)
    const dayV = report(day, TESTS, say)

    const five = makeTally()
    let weeks = 0
    for await (const [key, bars] of fiveMinuteWeeks()) {
        run(five, 'real', key, bars, false)
        run(five, 'shuf', key, E.shuffledBars(bars, E.seededRandom(seedOf(key))), false)
        if (++weeks % 500 === 0) console.log(`  5-minute ${weeks}`)
    }
    say(`\n## 5-minute, pooled — ${weeks} name-weeks`)
    const fiveV = report(five, TESTS, say, { perName: false })

    say('\n## Verdict (the declared PASS)')
    for (const t of TESTS) say(`${t.label}: daily trait ${dayV[t.key].trait ? 'PASS' : 'no'} · daily edge ${dayV[t.key].edge ? 'PASS' : 'no'} · 5-minute edge ${fiveV[t.key].edge ? 'PASS' : 'no'}`)
    fs.writeFileSync('data/lab/proteus-combos.out.txt', lines.join('\n') + '\n')
    console.log('→ data/lab/proteus-combos.out.txt')
    process.exit(0)
}
