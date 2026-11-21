#!/usr/bin/env node
// SIGNALS NOT YET TESTED (Roy, 2026-11-21) — declared in docs/design/proteus.md §10.12 before the run: RSI and MACD both
// ways (reclaims, divergences, crosses, the histogram), Ichimoku (Kijun, cloud, TK cross, the break above the cloud),
// RSI(2), the squeeze breakout, gaps, the first close over a prior swing high, and the existing tests filtered by the
// cloud. Each per name on the 10-year daily bars and pooled (daily + 5-minute), every series shuffled beside it.
//
// The SHORT side (the bearish signals) is the engine's own outcome on the MIRRORED bars (prices negated, high ↔ low):
// "+1 ATR first" there is "−1 ATR first" here — the same bracket, judged against the mirrored drift.
//
//   node --max-old-space-size=6000 scripts/lab-proteus-signals.mjs   → data/lab/proteus-signals.out.txt

import fs from 'fs'
import { E, P, atrsOf, calcSMASeries, calcEMASeries, calcRSISeries, calcMACDSeries, median, seedOf, dailyNames10y, fiveMinuteWeeks, makeTally, report } from './lab-proteus.shared.mjs'

export const TESTS = [
    { key: 'R1', label: 'R1. RSI 14 crosses back above 30 (long)' },
    { key: 'R2', label: 'R2. RSI bullish divergence (long)' },
    { key: 'R3', label: 'R3. RSI 14 crosses back below 70 (SHORT)' },
    { key: 'R4', label: 'R4. RSI bearish divergence (SHORT)' },
    { key: 'M1', label: 'M1. MACD cross up below zero (long)' },
    { key: 'M2', label: 'M2. MACD bullish divergence (long)' },
    { key: 'M3', label: 'M3. MACD histogram turns up below zero (long)' },
    { key: 'M4', label: 'M4. MACD cross down above zero (SHORT)' },
    { key: 'M5', label: 'M5. MACD bearish divergence (SHORT)' },
    { key: 'M6', label: 'M6. MACD histogram turns down above zero (SHORT)' },
    { key: 'I1', label: 'I1. Ichimoku Kijun touched from above (long, level)' },
    { key: 'I2', label: 'I2. Ichimoku cloud top touched from above (long, level)' },
    { key: 'I3', label: 'I3. Tenkan crosses up through Kijun above the cloud (long)' },
    { key: 'I4', label: 'I4. First close above the cloud (long)' },
    { key: 'X1', label: 'X1. RSI(2) under 10 over the 200 SMA (long)' },
    { key: 'X2', label: 'X2. Squeeze breakout — Bollinger width at its 120-bar low, then a close over the upper band (long)' },
    { key: 'G1', label: 'G1. Gap up ≥ 0.5 ATR that holds (long)' },
    { key: 'G2', label: 'G2. Gap down ≥ 0.5 ATR, bought (closes over its open) (long)' },
    { key: 'H1', label: 'H1. First close over the latest confirmed swing high (long)' },
    { key: 'F1', label: 'F1. 20 EMA touched from above, above the cloud (long, level)' },
    { key: 'F2', label: 'F2. 50 SMA touched from above, above the cloud (long, level)' },
    { key: 'F3', label: 'F3. RSI 14 under 30 above the cloud (long)' },
    { key: 'F4', label: 'F4. MACD cross up above the cloud (long)' },
]

const DIV = { swing: 2, from: 5, to: 40 }
const HIGH_SWING = 5

/** The bars mirrored: prices negated, high ↔ low — the long bracket on them is the short bracket on the real bars. */
export const mirror = (bars) => bars.map(b => ({ ...b, open: -b.open, high: -b.low, low: -b.high, close: -b.close }))

/** Rolling max / min of a field over `n` bars ending at i (null before n). */
function rolling(values, n, fn) {
    const out = new Array(values.length).fill(null)
    for (let i = n - 1; i < values.length; i++) {
        let v = values[i - n + 1]
        for (let k = i - n + 2; k <= i; k++) v = fn(v, values[k])
        out[i] = v
    }
    return out
}

/** Ichimoku at each bar, every value known at its bar (the spans plotted 26 ahead are read from 26 bars back). Pure. */
export function ichimoku(bars) {
    const hi = bars.map(b => b.high), lo = bars.map(b => b.low)
    const mid = (n) => { const h = rolling(hi, n, Math.max), l = rolling(lo, n, Math.min); return h.map((x, i) => (x == null || l[i] == null ? null : (x + l[i]) / 2)) }
    const tenkan = mid(9), kijun = mid(26), b52 = mid(52)
    const spanA = tenkan.map((t, i) => (t == null || kijun[i] == null ? null : (t + kijun[i]) / 2))
    const top = bars.map((_, i) => (i < 26 || spanA[i - 26] == null || b52[i - 26] == null ? null : Math.max(spanA[i - 26], b52[i - 26])))
    const bottom = bars.map((_, i) => (i < 26 || spanA[i - 26] == null || b52[i - 26] == null ? null : Math.min(spanA[i - 26], b52[i - 26])))
    return { tenkan, kijun, top, bottom }
}

/**
 * Divergences confirmed at the bar that confirms the second swing (j + DIV.swing). `kind` 'low': a swing low under the
 * previous one (5–40 bars before) with the indicator HIGHER at it; 'high' the mirror. → a Set of confirmation bars. Pure.
 */
export function divergences(bars, ind, kind) {
    const s = DIV.swing, out = new Set()
    const isLow = (j) => { for (let k = 1; k <= s; k++) if (!(bars[j].low < bars[j - k].low && bars[j].low <= bars[j + k].low)) return false; return true }
    const isHigh = (j) => { for (let k = 1; k <= s; k++) if (!(bars[j].high > bars[j - k].high && bars[j].high >= bars[j + k].high)) return false; return true }
    const swings = []
    for (let j = s; j + s < bars.length; j++) {
        if (!(kind === 'low' ? isLow(j) : isHigh(j)) || ind[j] == null) continue
        for (let p = swings.length - 1; p >= 0 && j - swings[p] <= DIV.to; p--) {
            const q = swings[p]
            if (j - q < DIV.from || ind[q] == null) continue
            const diverges = kind === 'low'
                ? bars[j].low < bars[q].low && ind[j] > ind[q]
                : bars[j].high > bars[q].high && ind[j] < ind[q]
            if (diverges) { out.add(j + s); break }
        }
        swings.push(j)
    }
    return out
}

/** One series → per test { event, base } outcome lists, and the cut. The engine's outcome, overlapping events skipped. */
export function signals(bars, opts = P) {
    const n = bars.length
    const atrs = atrsOf(bars)
    const cut = Math.floor(n * (1 - opts.recentShare))
    const closes = bars.map(b => b.close)
    const mbars = mirror(bars)
    const drift = E.driftOutcomes(bars, atrs, opts)
    const sdrift = E.driftOutcomes(mbars, atrs, opts)
    const ema20 = calcEMASeries(closes, 20), sma50 = calcSMASeries(closes, 50), sma200 = calcSMASeries(closes, 200), sma20 = calcSMASeries(closes, 20)
    const rsi = calcRSISeries(closes, 14), rsi2 = calcRSISeries(closes, 2)
    const { line, signal } = calcMACDSeries(closes)
    const hist = line.map((l, i) => (l == null || signal[i] == null ? null : l - signal[i]))
    const ich = ichimoku(bars)
    const above = (i) => ich.top[i] != null && closes[i] > ich.top[i]
    const atrPct = atrs.map((a, i) => (Number.isFinite(a) ? (a / closes[i]) * 100 : null))
    const medAtrPct = median(atrPct)

    const long = (pred) => E.eventOutcomes(bars, atrs, pred, opts)
    const short = (pred) => E.eventOutcomes(mbars, atrs, pred, opts)
    const shift = (lv, k) => lv.map(v => (Number.isFinite(v) ? v * (1 + k * medAtrPct / 100) : null))
    // A level's touches (the engine's rule) against its shifted copies; `when` keeps only bars it holds at.
    const level = (lv, when = () => true) => ({
        event: E.levelTouches(bars, lv, atrs, opts).filter(e => when(e.i)),
        base: opts.shifts.flatMap(k => E.levelTouches(bars, shift(lv, k), atrs, opts)).filter(e => when(e.i)),
    })

    const rsiDivL = divergences(bars, rsi, 'low'), rsiDivH = divergences(bars, rsi, 'high')
    const macdDivL = divergences(bars, line, 'low'), macdDivH = divergences(bars, line, 'high')

    // The squeeze: Bollinger width (4σ / mid) at its 120-bar low within the last 5 bars, then a close over the upper band.
    const sd = closes.map((_, i) => { if (i < 19) return null; const w = closes.slice(i - 19, i + 1), m = sma20[i]; return Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / 20) })
    const width = sd.map((s, i) => (s == null || !sma20[i] ? null : (4 * s) / sma20[i]))
    const wMin = rolling(width.map(w => (w == null ? Infinity : w)), 120, Math.min)
    const squeezed = (i) => { for (let k = 0; k < 5; k++) { const j = i - k; if (j < 0 || width[j] == null || wMin[j] == null || width[j] > wMin[j]) continue; return true } return false }
    const upper = (i) => (sd[i] == null ? null : sma20[i] + 2 * sd[i])

    // The latest confirmed swing high (5 bars each side, confirmed 5 bars after) at each bar.
    const lastHigh = new Array(n).fill(null)
    let cur = null
    for (let i = 0; i < n; i++) {
        const j = i - HIGH_SWING
        if (j >= HIGH_SWING) {
            let ok = true
            for (let k = 1; k <= HIGH_SWING && ok; k++) ok = bars[j].high > bars[j - k].high && bars[j].high >= bars[j + k].high
            if (ok) cur = bars[j].high
        }
        lastHigh[i] = cur
    }

    const crossUp = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] <= b[i - 1] && a[i] > b[i]
    const crossDn = (a, b, i) => crossUp(b, a, i)
    const over200 = (i) => Number.isFinite(sma200[i]) && closes[i] > sma200[i]
    const atrPrev = (i) => atrs[i - 1]

    const d = {
        R1: { event: long(i => rsi[i - 1] != null && rsi[i - 1] < 30 && rsi[i] >= 30), base: drift },
        R2: { event: long(i => rsiDivL.has(i)), base: drift },
        R3: { event: short(i => rsi[i - 1] != null && rsi[i - 1] > 70 && rsi[i] <= 70), base: sdrift },
        R4: { event: short(i => rsiDivH.has(i)), base: sdrift },
        M1: { event: long(i => crossUp(line, signal, i) && line[i] < 0), base: drift },
        M2: { event: long(i => macdDivL.has(i)), base: drift },
        M3: { event: long(i => i >= 2 && hist[i - 2] != null && hist[i] < 0 && hist[i] > hist[i - 1] && hist[i - 1] <= hist[i - 2]), base: drift },
        M4: { event: short(i => crossDn(line, signal, i) && line[i] > 0), base: sdrift },
        M5: { event: short(i => macdDivH.has(i)), base: sdrift },
        M6: { event: short(i => i >= 2 && hist[i - 2] != null && hist[i] > 0 && hist[i] < hist[i - 1] && hist[i - 1] >= hist[i - 2]), base: sdrift },
        I1: level(ich.kijun),
        I2: level(ich.top),
        I3: { event: long(i => crossUp(ich.tenkan, ich.kijun, i) && above(i)), base: drift },
        I4: { event: long(i => above(i) && ich.top[i - 1] != null && !(closes[i - 1] > ich.top[i - 1])), base: drift },
        X1: { event: long(i => rsi2[i] != null && rsi2[i] < 10 && over200(i)), base: drift.filter(e => over200(e.i)) },
        X2: { event: long(i => upper(i) != null && upper(i - 1) != null && closes[i] > upper(i) && closes[i - 1] <= upper(i - 1) && squeezed(i)), base: drift },
        G1: { event: long(i => Number.isFinite(atrPrev(i)) && bars[i].open >= closes[i - 1] + 0.5 * atrPrev(i) && closes[i] > bars[i].open), base: drift },
        G2: { event: long(i => Number.isFinite(atrPrev(i)) && bars[i].open <= closes[i - 1] - 0.5 * atrPrev(i) && closes[i] > bars[i].open), base: drift },
        H1: { event: long(i => lastHigh[i] != null && lastHigh[i - 1] === lastHigh[i] && closes[i] > lastHigh[i] && closes[i - 1] <= lastHigh[i]), base: drift },
        F1: level(ema20, above),
        F2: level(sma50, above),
        F3: { event: long(i => rsi[i - 1] != null && rsi[i - 1] >= 30 && rsi[i] < 30 && above(i)), base: drift.filter(e => above(e.i)) },
        F4: { event: long(i => crossUp(line, signal, i) && above(i)), base: drift.filter(e => above(e.i)) },
    }
    return { d, cut }
}

function run(tally, side, sym, bars, perName) {
    const { d, cut } = signals(bars)
    for (const t of TESTS) {
        const g = d[t.key]
        if (perName) tally.verdict(t.key, side, E.judge(g.event, g.base, cut).verdict, sym)
        tally.pool(t.key, side, 'event', bars, g.event)
        tally.pool(t.key, side, 'base', bars, g.base)
    }
}

if (process.argv[1]?.endsWith('lab-proteus-signals.mjs')) {   // run, not imported
    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    say(`# Signals not yet tested (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.12, PROFILE as built (z ${P.z}, edge ${P.edge}, horizon ${P.horizon})`)

    const day = makeTally()
    let names = 0
    for await (const [sym, bars] of dailyNames10y()) {
        run(day, 'real', sym, bars, true)
        run(day, 'shuf', sym, E.shuffledBars(bars, E.seededRandom(seedOf(sym))), true)
        if (++names % 100 === 0) console.log(`  daily ${names}`)
    }
    say(`\n## Daily — ${names} names, 10 years; pooled split at 2026-03-01`)
    const dayV = report(day, TESTS, say)

    const five = makeTally()
    let weeks = 0
    for await (const [key, bars] of fiveMinuteWeeks()) {
        run(five, 'real', key, bars, false)
        run(five, 'shuf', key, E.shuffledBars(bars, E.seededRandom(seedOf(key))), false)
        if (++weeks % 1000 === 0) console.log(`  5-minute ${weeks}`)
    }
    say(`\n## 5-minute, pooled — ${weeks} name-weeks`)
    const fiveV = report(five, TESTS, say, { perName: false })

    say('\n## Verdict (the declared PASS)')
    for (const t of TESTS) say(`${t.label}: daily trait ${dayV[t.key].trait ? 'PASS' : 'no'} · daily edge ${dayV[t.key].edge ? 'PASS' : 'no'} · 5-minute edge ${fiveV[t.key].edge ? 'PASS' : 'no'}`)
    fs.writeFileSync('data/lab/proteus-signals.out.txt', lines.join('\n') + '\n')
    console.log('→ data/lab/proteus-signals.out.txt')
    process.exit(0)
}
