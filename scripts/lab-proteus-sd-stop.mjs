#!/usr/bin/env node
// A STANDARD-DEVIATION STOP (Roy, 2026-11-21: "what about standard deviation for stop?"). An entry at every close; σ = the
// standard deviation of the last 60 daily returns × √(the horizon) — how far the name usually moves over the trade's span;
// the stop k × σ under the entry (k 1 … 3); the target a multiple of that risk (1R … 3R) or none. Against holding and the
// fixed 8% / 8%, per horizon, whole period and year by year. 0.1% cost.
//
//   node scripts/lab-proteus-sd-stop.mjs [SYM=KO]

import fs from 'fs'

const SYM = (process.argv[2] ?? 'KO').toUpperCase()
const line = fs.readFileSync('data/lab/screener-10y.jsonl', 'utf8').split('\n').find(l => l.startsWith(`{"symbol":"${SYM}"`))
const rows = JSON.parse(line).b.map(([t, , high, low, close]) => ({ t, high, low, close })).sort((a, b) => a.t - b.t)
const n = rows.length, COST = 0.001, LOOK = 60
const KS = [1, 1.5, 2, 2.5, 3], PLANS = [['1R', 1], ['1.5R', 1.5], ['2R', 2], ['3R', 3], ['none', null]]

// σ of daily returns over the last 60 sessions, known at the bar's close.
const ret = rows.map((b, i) => (i ? b.close / rows[i - 1].close - 1 : 0))
const sd = rows.map((_, i) => {
    if (i < LOOK) return null
    const w = ret.slice(i - LOOK + 1, i + 1), m = w.reduce((s, x) => s + x, 0) / LOOK
    return Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / (LOOK - 1))
})

function trade(i, cap, stop, tgt) {
    const c = rows[i].close
    for (let j = i + 1; j <= i + cap; j++) {
        if (stop != null && rows[j].low <= stop) return [stop / c - 1 - COST, j - i]
        if (tgt != null && rows[j].high >= tgt) return [tgt / c - 1 - COST, j - i]
    }
    return [rows[i + cap].close / c - 1 - COST, cap]
}

const f = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(3)}%`
const yr = (i) => new Date(rows[i].t * 1000).getUTCFullYear()
console.log(`# ${SYM} — the stop k × σ under the entry (σ = 60-day daily σ × √horizon); ${n} sessions`)
for (const cap of [10, 21, 42, 63]) {
    const acc = {}
    const add = (key, y, r, h) => { for (const kk of [`${key}|all`, `${key}|${y}`]) { const a = (acc[kk] ??= [0, 0]); a[0] += r; a[1] += h } }
    const dists = []
    for (let i = LOOK; i + cap < n; i++) {
        const c = rows[i].close, s = sd[i] * Math.sqrt(cap), y = yr(i)
        dists.push(s)
        for (const k of KS) for (const [name, R] of PLANS) {
            const risk = k * s * c
            const [r, h] = trade(i, cap, c - risk, R == null ? null : c + R * risk)
            add(`${k}σ ${name}`, y, r, h)
        }
        { const [r, h] = trade(i, cap, c * 0.92, c * 1.08); add('8%/8%', y, r, h) }
        add('hold', y, rows[i + cap].close / c - 1 - COST, cap)
    }
    dists.sort((a, b) => a - b)
    const pd = (key) => acc[key][0] / acc[key][1]
    const years = [...new Set(Object.keys(acc).map(x => x.split('|')[1]).filter(x => x !== 'all'))].sort()
    const beatYears = (key) => years.filter(y => pd(`${key}|${y}`) > pd(`hold|${y}`)).length
    const hold = pd('hold|all')
    console.log(`\n## ${cap} sessions — 1σ over the span: median ${(dists[dists.length >> 1] * 100).toFixed(1)}% · hold ${f(hold)}/session · 8%/8% ${f(pd('8%/8%|all'))} (${((pd('8%/8%|all') - hold) * 25200).toFixed(1)}%/yr, ${beatYears('8%/8%')} of ${years.length} yrs)`)
    console.log('       ' + PLANS.map(p => p[0].padStart(22)).join(''))
    for (const k of KS) {
        console.log(`  ${`${k}σ`.padEnd(5)}` + PLANS.map(([name]) => { const key = `${k}σ ${name}|all`; return `${((pd(key) - hold) * 25200).toFixed(1).padStart(6)}%/yr ${String(beatYears(`${k}σ ${name}`)).padStart(2)}/${years.length}y    ` }).join(''))
    }
}
console.log('\nCells: the difference from holding in % a year (per session held × 252), and the years of 11 it beat holding.')
