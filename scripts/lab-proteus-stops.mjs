#!/usr/bin/env node
// LINES AS STOPS, PER NAME (Roy, 2026-11-16: "each ticker behaves individually — check stops in the same manner Proteus
// checks reaction to patterns"). Declared in docs/design/proteus.md §10.3 before the run. A stop 0.2 ATR under each
// anchor (Mentor's own buffer); when it is hit — did the line break for real (a GOOD stop) or did price close back over
// it (a whipsaw)? Against the same anchor shifted ±2/±3 median ATRs. Per name daily, pooled daily and 5-minute, with every
// series shuffled through the identical pipeline beside it.
//
//   node --max-old-space-size=6000 scripts/lab-proteus-stops.mjs   → data/lab/proteus-stops.out.txt

import fs from 'fs'
import { E, P, atrsOf, calcSMASeries, calcEMASeries, median, seedOf, pct, dailyNames, fiveMinuteWeeks, makeTally, report } from './lab-proteus.shared.mjs'

const ROOT = new URL('../', import.meta.url)
const { STRUCTURE, atr: structureAtr, swings: structureSwings } = await import(new URL('services/swingStructure.service.js', ROOT))
const { detectOrderBlocks } = await import(new URL('services/smc.engine.js', ROOT))

/** 1 ATR past the stop: the line broke for real. */
export const DEEP = 1

export const ANCHORS = [
    { key: 'swing', label: 'SWING — the latest swing low of Mentor\'s swings (1.5 ATR)' },
    { key: 'ema20', label: 'EMA20' },
    { key: 'sma50', label: 'SMA50' },
    { key: 'sma200', label: 'SMA200' },
    { key: 'range', label: 'RANGE — the low of the Wyckoff range price is in' },
    { key: 'fib618', label: 'FIB618 — the 61.8% level of the pullback under way' },
    { key: 'ob', label: 'OB — the bottom of the latest known bullish order block under price' },
    { key: 'vwap', label: 'VWAP (5-minute only)', intradayOnly: true },
]

/**
 * The stop hits on one anchor series. At bar i the anchor is `anc[i-1]` (known before the bar) and the ATR `atrs[i-1]`.
 * A HIT: the previous close over the anchor, this bar's low under anchor − buffer·ATR. From the hit bar on, within
 * `horizon` bars: a close back over the anchor first → 'loss' (a whipsaw — the hit bar's own close included, checked
 * first like the engine's bracket); a low DEEP ATR past the stop first → 'win' (a good stop); neither → 'none'. Bars run
 * out → not counted. One hit per `horizon` bars. Pure.
 */
export function stopHits(bars, atrs, anc, opts = P, buffer = STRUCTURE.buffer) {
    const out = []
    for (let i = 1; i < bars.length; i++) {
        const L = anc[i - 1], a = atrs[i - 1]
        if (!Number.isFinite(L) || !Number.isFinite(a) || a <= 0) continue
        if (!(bars[i - 1].close > L && bars[i].low < L - buffer * a)) continue
        if (i + opts.horizon >= bars.length) break
        const deep = L - (buffer + DEEP) * a
        let o = 'none'
        for (let k = i; k <= i + opts.horizon; k++) {
            if (bars[k].close > L) { o = 'loss'; break }
            if (bars[k].low <= deep) { o = 'win'; break }
        }
        out.push({ i, out: o })
        i += opts.horizon
    }
    return out
}

/** One series → each anchor's level by bar (null where there is none). Pure. */
export function anchors(bars, { intraday = false } = {}, opts = P) {
    const n = bars.length, closes = bars.map(b => b.close)
    const atrs = atrsOf(bars), cut = Math.floor(n * (1 - opts.recentShare))
    const drift = E.driftOutcomes(bars, atrs, opts)
    const fb = E.falseBreaks(bars, atrs, cut, drift, opts)
    const wy = E.wyckoffTest(bars, atrs, cut, drift, fb.sweeps, opts)
    const fib = E.fibPullbackTest(bars, atrs, cut, opts)
    const blank = () => new Array(n).fill(null)

    // SWING: the latest swing low of the trader's own swings, from the bar that confirms it.
    const swing = blank()
    const lows = structureSwings(bars, structureAtr(bars), STRUCTURE.k).filter(s => s.type === 'L')
    for (let i = 0, k = -1; i < n; i++) { while (k + 1 < lows.length && lows[k + 1].at <= i) k++; if (k >= 0) swing[i] = lows[k].price }

    const range = blank()
    for (const r of wy.range_list) for (let b = r.known; b <= r.until && b < n; b++) range[b] = r.low
    const fib618 = blank()
    for (const pb of fib.pullbacks) for (let b = pb.start; b < pb.end && b < n; b++) fib618[b] = pb.high - 0.618 * (pb.high - pb.low)

    // OB: the latest bullish block known by then (orderBlockTest's rule: two bars after its impulse) under the close.
    const at = new Map(bars.map((b, i) => [b.timestamp, i]))
    const blocks = detectOrderBlocks(bars).filter(o => o.type === 'bullish')
        .map(o => ({ bottom: o.bottom, known: at.get(o.impulseAt) + 2 })).filter(o => Number.isFinite(o.known)).sort((a, b) => a.known - b.known)
    const ob = blank()
    for (let i = 0, k = 0, live = []; i < n; i++) {
        while (k < blocks.length && blocks[k].known <= i) live.push(blocks[k++])
        for (let j = live.length - 1; j >= 0; j--) if (live[j].bottom < closes[i]) { ob[i] = live[j].bottom; break }
    }

    const out = { swing, ema20: calcEMASeries(closes, 20), sma50: calcSMASeries(closes, 50), sma200: calcSMASeries(closes, 200), range, fib618, ob }
    if (intraday) out.vwap = E.sessionVwap(bars)
    const atrPct = median(atrs.map((a, i) => (Number.isFinite(a) ? (a / closes[i]) * 100 : null)))
    return { levels: out, atrs, cut, atrPct }
}

const shift = (lv, k, atrPct) => lv.map(v => (Number.isFinite(v) ? v * (1 + k * atrPct / 100) : null))

function run(tally, side, sym, bars, { perName, intraday }) {
    const { levels, atrs, cut, atrPct } = anchors(bars, { intraday })
    for (const t of ANCHORS) {
        const lv = levels[t.key]
        if (!lv) continue
        const event = stopHits(bars, atrs, lv)
        const base = P.shifts.flatMap(k => stopHits(bars, atrs, shift(lv, k, atrPct)))
        if (perName) tally.verdict(t.key, side, E.judge(event, base, cut).verdict, sym)
        tally.pool(t.key, side, 'event', bars, event)
        tally.pool(t.key, side, 'shifted', bars, base)
    }
}

/** Said, not judged: the good-stop share of the hits (pooled, real, both periods). */
function whipsaws(tally, say) {
    say('\ngood-stop share of the hits (real, pooled) — 1 ATR more before a close back over the line (the rest: whipsaws, or neither in 10 bars):')
    for (const t of ANCHORS) {
        const g = tally.pooled[t.key]?.real
        if (!g) continue
        say(`  ${t.key.padEnd(7)} ` + ['older', 'recent'].map(p => {
            const [n, w] = g[p]?.event ?? [0, 0]
            return `${p} good ${pct(n ? w / n : null)} (n ${n})`
        }).join('   '))
    }
}

if (process.argv[1]?.endsWith('lab-proteus-stops.mjs')) {   // run, not imported (the unit test imports it)
    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    say(`# Lines as stops, per name (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.3; the stop ${STRUCTURE.buffer} ATR under the line, GOOD = ${DEEP} ATR past it before a close back over, ${P.horizon} bars`)

    const day = makeTally()
    let names = 0
    for (const [sym, bars] of dailyNames()) {
        run(day, 'real', sym, bars, { perName: true, intraday: false })
        run(day, 'shuf', sym, E.shuffledBars(bars, E.seededRandom(seedOf(sym))), { perName: true, intraday: false })
        if (++names % 100 === 0) console.log(`  daily ${names}`)
    }
    const dayTests = ANCHORS.filter(t => !t.intradayOnly)
    say(`\n## Daily — ${names} names, ~4 years each (2022-09 → 2026-10); pooled split at 2026-03-01`)
    const dayV = report(day, dayTests, say)
    whipsaws(day, say)

    const five = makeTally()
    let weeks = 0
    for await (const [key, bars] of fiveMinuteWeeks()) {
        run(five, 'real', key, bars, { perName: false, intraday: true })
        run(five, 'shuf', key, E.shuffledBars(bars, E.seededRandom(seedOf(key))), { perName: false, intraday: true })
        if (++weeks % 500 === 0) console.log(`  5-minute ${weeks}`)
    }
    say(`\n## 5-minute, pooled — ${weeks} name-weeks`)
    const fiveV = report(five, ANCHORS, say, { perName: false })
    whipsaws(five, say)

    say('\n## Verdict (the declared PASS)')
    for (const t of ANCHORS) say(`${t.label}: ${dayV[t.key] ? `daily trait ${dayV[t.key].trait ? 'PASS' : 'no'} · daily edge ${dayV[t.key].edge ? 'PASS' : 'no'} · ` : ''}5-minute edge ${fiveV[t.key].edge ? 'PASS' : 'no'}`)
    fs.writeFileSync('data/lab/proteus-stops.out.txt', lines.join('\n') + '\n')
    console.log('→ data/lab/proteus-stops.out.txt')
    process.exit(0)
}
