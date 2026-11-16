#!/usr/bin/env node
// INDICATOR VALUES, PER NAME (Roy, 2026-11-16: "what about different values of indicators and atr"). Declared in
// docs/design/proteus.md §10.4 before the run. Per name and family, the older two-thirds choose the value, the recent
// third checks only that one; each name's shuffled bars run the identical search beside it. Daily, ~10 years.
//
//   node --max-old-space-size=6000 scripts/lab-proteus-values.mjs   → data/lab/proteus-values.out.txt

import fs from 'fs'
import { E, P, atrsOf, calcSMASeries, calcEMASeries, calcRSISeries, median, seedOf, pct, dailyNames10y, makeTally, HELD_OUT } from './lab-proteus.shared.mjs'
import { stopHits } from './lab-proteus-stops.mjs'

const ROOT = new URL('../', import.meta.url)
const { atr: structureAtr, swings: structureSwings } = await import(new URL('services/swingStructure.service.js', ROOT))

const MA_LENGTHS = [10, 20, 50, 100, 200]
export const FAMILIES = [
    { key: 'ma_support', label: '1. MA as support (touch vs the line shifted)', values: MA_LENGTHS.flatMap(n => [`ema${n}`, `sma${n}`]) },
    { key: 'ma_stop', label: '2. MA as a stop (0.2 ATR under; good = 1 ATR more vs the line shifted)', values: MA_LENGTHS.flatMap(n => [`ema${n}`, `sma${n}`]) },
    { key: 'rsi', label: '3. RSI oversold (period × level, vs the drift)', values: [2, 7, 14].flatMap(p => [10, 20, 30].map(l => `rsi${p}<${l}`)) },
    { key: 'volume', label: '4. Volume up bar (× the 20-bar average, vs the drift)', values: ['1.5x', '2x', '3x'] },
    { key: 'swing', label: "5. Swing size as a stop (Mentor's swings, k ATR)", values: ['k1', 'k1.5', 'k2', 'k3'] },
]

const shift = (lv, k, atrPct) => lv.map(v => (Number.isFinite(v) ? v * (1 + k * atrPct / 100) : null))

/** The latest confirmed swing low of a `k`-ATR zigzag, by bar (§10.3's SWING anchor at another k). Pure. */
function swingSeries(bars, k) {
    const lows = structureSwings(bars, structureAtr(bars), k).filter(s => s.type === 'L')
    const out = new Array(bars.length).fill(null)
    for (let i = 0, j = -1; i < bars.length; i++) { while (j + 1 < lows.length && lows[j + 1].at <= i) j++; if (j >= 0) out[i] = lows[j].price }
    return out
}

/**
 * One series → per family, per value `{ events, base, j }` (j = judge's result). Pure (the engine's judge decides).
 */
export function values(bars, opts = P) {
    const n = bars.length, closes = bars.map(b => b.close), atrs = atrsOf(bars)
    const cut = Math.floor(n * (1 - opts.recentShare))
    const atrPct = median(atrs.map((a, i) => (Number.isFinite(a) ? (a / closes[i]) * 100 : null)))
    const drift = E.driftOutcomes(bars, atrs, opts)
    const lines = Object.fromEntries(MA_LENGTHS.flatMap(L => [[`ema${L}`, calcEMASeries(closes, L)], [`sma${L}`, calcSMASeries(closes, L)]]))
    const vol20 = calcSMASeries(bars.map(b => b.volume ?? 0), 20)
    const out = {}
    const put = (fam, val, events, base) => { (out[fam] ??= {})[val] = { events, base, j: E.judge(events, base, cut, opts) } }
    for (const [k, lv] of Object.entries(lines)) {
        put('ma_support', k, E.levelTouches(bars, lv, atrs, opts), opts.shifts.flatMap(s => E.levelTouches(bars, shift(lv, s, atrPct), atrs, opts)))
        put('ma_stop', k, stopHits(bars, atrs, lv, opts), opts.shifts.flatMap(s => stopHits(bars, atrs, shift(lv, s, atrPct), opts)))
    }
    for (const p of [2, 7, 14]) {
        const rsi = calcRSISeries(closes, p)
        for (const l of [10, 20, 30]) put('rsi', `rsi${p}<${l}`, E.eventOutcomes(bars, atrs, i => rsi[i - 1] != null && rsi[i - 1] >= l && rsi[i] < l, opts), drift)
    }
    for (const [val, m] of [['1.5x', 1.5], ['2x', 2], ['3x', 3]]) {
        put('volume', val, E.eventOutcomes(bars, atrs, i => vol20[i - 1] > 0 && bars[i].volume >= m * vol20[i - 1] && bars[i].close > bars[i].open, opts), drift)
    }
    for (const k of [1, 1.5, 2, 3]) {
        const lv = swingSeries(bars, k)
        put('swing', `k${k}`, stopHits(bars, atrs, lv, opts), opts.shifts.flatMap(s => stopHits(bars, atrs, shift(lv, s, atrPct), opts)))
    }
    return out
}

/** A name's value in one family: the largest older-part edge among the values not thin → `{ value, verdict }`. Pure. */
export function chooseValue(fam) {
    let best = null
    for (const [value, { j }] of Object.entries(fam)) {
        if (j.verdict === 'thin' || j.edge == null) continue
        if (!best || j.edge > best.j.edge) best = { value, j }
    }
    return best ? { value: best.value, verdict: best.j.verdict, j: best.j } : { value: null, verdict: 'thin' }
}

if (process.argv[1]?.endsWith('lab-proteus-values.mjs')) {   // run, not imported (the unit test imports it)
    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    say(`# Indicator values, per name (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.4, PROFILE as built (z ${P.z}, edge ${P.edge}, horizon ${P.horizon})`)
    const tally = makeTally(), chosen = { real: {}, shuf: {} }, flaggedJ = {}
    const pool = {}   // `${fam}|${value}` → real/shuf → older/recent → { events: [n,w], base: [n,w] }
    const addPool = (key, side, bars, evs, group) => {
        for (const e of evs) {
            if (!e.out) continue
            const part = bars[e.i].timestamp >= HELD_OUT ? 'recent' : 'older'
            const c = (((pool[key] ??= {})[side] ??= {})[part] ??= { events: [0, 0], base: [0, 0] })[group]
            c[0]++
            if (e.out === 'win') c[1]++
        }
    }
    let names = 0, years = []
    for await (const [sym, bars] of dailyNames10y()) {
        years.push((bars.at(-1).timestamp - bars[0].timestamp) / (365.25 * 86400))
        for (const side of ['real', 'shuf']) {
            const series = side === 'real' ? bars : E.shuffledBars(bars, E.seededRandom(seedOf(sym)))
            const v = values(series)
            for (const f of FAMILIES) {
                const c = chooseValue(v[f.key])
                tally.verdict(f.key, side, c.verdict, sym)
                if (c.value) ((chosen[side][f.key] ??= {})[c.value] = (chosen[side][f.key][c.value] ?? 0) + 1)
                if (side === 'real' && c.verdict === 'respects') (flaggedJ[f.key] ??= []).push(`${sym} ${c.value} (${pct(c.j.rate)} vs ${pct(c.j.base)}, z ${c.j.z}; recent ${pct(c.j.recent.rate)} vs ${pct(c.j.recent.base)})`)
                for (const [val, { events, base }] of Object.entries(v[f.key])) {
                    addPool(`${f.key}|${val}`, side, series, events, 'events')
                    addPool(`${f.key}|${val}`, side, series, base, 'base')
                }
            }
        }
        if (++names % 100 === 0) console.log(`  ${names}`)
    }
    years.sort((a, b) => a - b)
    say(`\n${names} names, median ${years[years.length >> 1].toFixed(1)} years of daily bars; pooled split at 2026-03-01`)
    const order = (o) => Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'
    const verdict = {}
    for (const f of FAMILIES) {
        const v = tally.verdicts[f.key] ?? { real: {}, shuf: {} }
        const r = v.real.respects ?? 0, s = v.shuf.respects ?? 0
        verdict[f.key] = r >= 2 * s && r >= s + 10
        say(`\n### ${f.label}`)
        say(`per name — real:     ${order(v.real)}`)
        say(`           shuffled: ${order(v.shuf)}`)
        say(`respects: real ${r} vs shuffled ${s} → ${verdict[f.key] ? 'PASS (this ticker has its own value)' : 'no'}`)
        if (flaggedJ[f.key]?.length) say(`  real respects: ${flaggedJ[f.key].slice(0, 30).join('; ')}${flaggedJ[f.key].length > 30 ? ' …' : ''}`)
        say(`the value names pick (not thin) — real:     ${order(chosen.real[f.key])}`)
        say(`                                  shuffled: ${order(chosen.shuf[f.key])}`)
        say('pooled, real (event vs baseline) — older | recent:')
        for (const val of f.values) {
            const g = pool[`${f.key}|${val}`]?.real ?? {}
            say(`  ${val.padEnd(9)} ` + ['older', 'recent'].map(part => {
                const { events: [en, ew] = [0, 0], base: [bn, bw] = [0, 0] } = g[part] ?? {}
                return `${pct(en ? ew / en : null)} vs ${pct(bn ? bw / bn : null)} (n ${en})`
            }).join(' | '))
        }
    }
    say('\n## Verdict (the declared PASS)')
    for (const f of FAMILIES) say(`${f.label}: ${verdict[f.key] ? 'PASS' : 'no'}`)
    fs.writeFileSync('data/lab/proteus-values.out.txt', lines.join('\n') + '\n')
    console.log('→ data/lab/proteus-values.out.txt')
    process.exit(0)
}
