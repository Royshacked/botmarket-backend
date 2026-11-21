#!/usr/bin/env node
// THE REGIME LAB, ONE NAME (Roy, 2026-11-21: "run the regime lab on KO"). KO's best bracket flipped with its regime (a range
// 2016–21 → quick profits; a trend since → holding). Does a regime read KNOWN AT THE ENTRY tell which trade to take?
//
//   THE READ (at each close, from the last 63 sessions only): the efficiency ratio ER = |close − close 63 back| / the sum of
//   the 63 daily |moves| (1 = a clean trend, 0 = all noise), its sign the direction. Ranked against ALL EARLIER days' ER
//   (an expanding percentile — no look-ahead): RANGE = the bottom third, TREND = the top third (up / down by the sign).
//   THE TRADES (σ = the 60-day daily σ × √horizon, 0.1% cost): RANGE trades — 1σ stop 1:1; 1.25σ stop 1:0.75. TREND
//   trades — a 2σ stop, no target; holding.
//   THE TEST: per regime, each trade's return per session held; and SWITCH (the range trade in a RANGE read, holding
//   otherwise) against always holding and always range-trading. Horizons 10, 63, 126 sessions; the two halves; the shuffled
//   name beside it (no regimes to read — switching should not help there).
//
//   node scripts/lab-proteus-regime.mjs [SYM=KO]

import fs from 'fs'
import { E, seedOf } from './lab-proteus.shared.mjs'

const SYM = (process.argv[2] ?? 'KO').toUpperCase()
const COST = 0.001, LOOK = 60, ERL = 63, HALF = Date.parse('2021-10-26T00:00:00Z') / 1000
const raw = JSON.parse(fs.readFileSync('data/lab/screener-10y.jsonl', 'utf8').split('\n').find(l => l.startsWith(`{"symbol":"${SYM}"`))).b
const real = raw.map(([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume })).sort((a, b) => a.timestamp - b.timestamp)

function analyse(rows) {
    const n = rows.length
    const ret = rows.map((b, i) => (i ? b.close / rows[i - 1].close - 1 : 0))
    const sd = rows.map((_, i) => { if (i < LOOK) return null; const w = ret.slice(i - LOOK + 1, i + 1), m = w.reduce((s, x) => s + x, 0) / LOOK; return Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / (LOOK - 1)) })
    // The efficiency ratio and its expanding percentile.
    const er = rows.map((_, i) => { if (i < ERL) return null; let path = 0; for (let k = i - ERL + 1; k <= i; k++) path += Math.abs(rows[k].close - rows[k - 1].close); return path ? (rows[i].close - rows[i - ERL].close) / path : null })
    const seen = [], regime = new Array(n).fill(null)
    for (let i = 0; i < n; i++) {
        if (er[i] == null) continue
        const a = Math.abs(er[i])
        if (seen.length >= 250) {
            let below = 0
            for (const x of seen) if (x < a) below++
            const p = below / seen.length
            regime[i] = p < 1 / 3 ? 'range' : p > 2 / 3 ? (er[i] > 0 ? 'up' : 'down') : 'mixed'
        }
        seen.push(a)
    }
    const trade = (i, cap, stop, tgt) => {
        const c = rows[i].close
        for (let j = i + 1; j <= i + cap; j++) {
            if (stop != null && rows[j].low <= stop) return [stop / c - 1 - COST, j - i]
            if (tgt != null && rows[j].high >= tgt) return [tgt / c - 1 - COST, j - i]
        }
        return [rows[i + cap].close / c - 1 - COST, cap]
    }
    const out = {}
    for (const cap of [10, 63, 126]) {
        const acc = {}
        const add = (key, r, h) => { const a = (acc[key] ??= [0, 0]); a[0] += r; a[1] += h }
        for (let i = 0; i + cap < n; i++) {
            if (!regime[i] || sd[i] == null) continue
            const c = rows[i].close, s = sd[i] * Math.sqrt(cap), half = rows[i].timestamp < HALF ? 'older' : 'recent'
            const t = {
                'range 1σ 1:1': trade(i, cap, c * (1 - s), c * (1 + s)),
                'range 1.25σ 1:0.75': trade(i, cap, c * (1 - 1.25 * s), c * (1 + 0.9375 * s)),
                'trend 2σ, no target': trade(i, cap, c * (1 - 2 * s), null),
                hold: trade(i, cap, null, null),
            }
            t.SWITCH = regime[i] === 'range' ? t['range 1σ 1:1'] : t.hold
            for (const [k, [r, h]] of Object.entries(t)) for (const part of ['all', half]) { add(`${part}|${regime[i]}|${k}`, r, h); add(`${part}|any|${k}`, r, h) }
        }
        out[cap] = acc
    }
    return out
}

const pd = (acc, key) => (acc[key] ? (acc[key][0] / acc[key][1]) * 25200 : null)
const f = (x) => (x == null ? '    —' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}`.padStart(6))
const TRADES = ['range 1σ 1:1', 'range 1.25σ 1:0.75', 'trend 2σ, no target', 'hold']
const R = analyse(real), S = analyse(E.shuffledBars(real, E.seededRandom(seedOf(SYM))))
console.log(`# ${SYM} — the regime lab: does a regime read KNOWN at the entry pick the trade? (% a year, per session held)`)
console.log('Regime: the 63-session efficiency ratio, ranked against all earlier days — range (bottom third), up / down trend (top third), mixed.')
for (const cap of [10, 63, 126]) {
    console.log(`\n## ${cap} sessions`)
    for (const part of ['all', 'older', 'recent']) {
        console.log(`  ${part === 'all' ? '10 years' : part === 'older' ? '2016–21' : '2021–26'}: per regime — ${TRADES.join(' · ')}`)
        for (const reg of ['range', 'mixed', 'up', 'down']) {
            const cells = TRADES.map(t => f(pd(R[cap], `${part}|${reg}|${t}`)))
            const n = R[cap][`${part}|${reg}|hold`]?.[1] / cap
            console.log(`    ${reg.padEnd(6)} ${cells.join('  ')}   (~${Math.round(n || 0)} entries)`)
        }
        const sw = pd(R[cap], `${part}|any|SWITCH`), ho = pd(R[cap], `${part}|any|hold`), ra = pd(R[cap], `${part}|any|range 1σ 1:1`)
        const ssw = pd(S[cap], `${part}|any|SWITCH`), sho = pd(S[cap], `${part}|any|hold`)
        console.log(`    SWITCH (range trade in a range read, else hold) ${f(sw)} vs always hold ${f(ho)} (${f(sw - ho)}) vs always range-trade ${f(ra)}  ·  shuffled: switch − hold ${f(ssw - sho)}`)
    }
}
