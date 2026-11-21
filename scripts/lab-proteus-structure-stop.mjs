#!/usr/bin/env node
// THE STOP WHERE SELLERS WERE LAST IN CONTROL (Roy, 2026-11-21: "what if we put the stops where sellers were in control
// the last time before the trade?"). An entry at every close; the stop 0.2 ATR under the last CONFIRMED swing low below
// the price (Mentor's own swings: swingStructure.swings, 1.5 ATR, known from the confirming bar; STRUCTURE.buffer); the
// target a multiple of that risk (1R, 1.5R, 2R, 3R) or none (the stop or the horizon's close). Against holding and the
// fixed 8% / 8%, per horizon, whole period and year by year. 0.1% cost.
//
//   node scripts/lab-proteus-structure-stop.mjs [SYM=KO]

import fs from 'fs'
import { swings, atr, STRUCTURE } from '../services/swingStructure.service.js'

const SYM = (process.argv[2] ?? 'KO').toUpperCase()
const line = fs.readFileSync('data/lab/screener-10y.jsonl', 'utf8').split('\n').find(l => l.startsWith(`{"symbol":"${SYM}"`))
const rows = JSON.parse(line).b.map(([t, open, high, low, close, volume]) => ({ t, open, high, low, close, volume })).sort((a, b) => a.t - b.t)
const n = rows.length, A = atr(rows, 20), COST = 0.001
const lows = swings(rows, A, STRUCTURE.k).filter(s => s.type === 'L')

// The structural stop at each bar: the last swing low CONFIRMED by i (at ≤ i) under the close, minus the buffer.
const stopAt = new Array(n).fill(null)
let k = 0
const known = []
for (let i = 0; i < n; i++) {
    while (k < lows.length && lows[k].at <= i) known.push(lows[k++])
    if (A[i] == null) continue
    for (let m = known.length - 1; m >= 0; m--) if (known[m].price < rows[i].close) { stopAt[i] = known[m].price - STRUCTURE.buffer * A[i]; break }
}

/** One trade from i: [return, sessions held]. `tgtR` null = no target. */
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
const dist = stopAt.map((s, i) => (s == null ? null : 1 - s / rows[i].close)).filter(x => x != null).sort((a, b) => a - b)
console.log(`# ${SYM} — the stop 0.2 ATR under the last confirmed swing low (1.5 ATR swings); ${n} sessions`)
console.log(`The stop's distance under the entry: median ${(dist[dist.length >> 1] * 100).toFixed(1)}%, middle half ${(dist[Math.floor(dist.length / 4)] * 100).toFixed(1)}–${(dist[Math.floor(dist.length * 3 / 4)] * 100).toFixed(1)}%`)
const PLANS = [['1R', 1], ['1.5R', 1.5], ['2R', 2], ['3R', 3], ['no target', null]]
for (const cap of [10, 21, 42, 63]) {
    const acc = {}
    const add = (key, y, r, h) => { for (const kk of [`${key}|all`, `${key}|${y}`]) { const a = (acc[kk] ??= [0, 0]); a[0] += r; a[1] += h } }
    for (let i = 0; i + cap < n; i++) {
        if (stopAt[i] == null) continue
        const c = rows[i].close, risk = c - stopAt[i], y = yr(i)
        for (const [name, R] of PLANS) { const [r, h] = trade(i, cap, stopAt[i], R == null ? null : c + R * risk); add(name, y, r, h) }
        { const [r, h] = trade(i, cap, c * 0.92, c * 1.08); add('8%/8%', y, r, h) }
        add('hold', y, rows[i + cap].close / c - 1 - COST, cap)
    }
    const pd = (key) => acc[key][0] / acc[key][1]
    const years = [...new Set(Object.keys(acc).map(x => x.split('|')[1]).filter(x => x !== 'all'))].sort()
    console.log(`\n## ${cap} sessions — per session held (vs hold): the years it beat holding`)
    for (const name of [...PLANS.map(p => p[0]), '8%/8%', 'hold']) {
        const beat = name === 'hold' ? '' : years.filter(y => pd(`${name}|${y}`) > pd(`hold|${y}`)).length
        console.log(`  ${name.padEnd(10)} ${f(pd(`${name}|all`)).padStart(8)}${name === 'hold' ? '' : `  (${f(pd(`${name}|all`) - pd('hold|all'))} · ≈ ${((pd(`${name}|all`) - pd('hold|all')) * 25200).toFixed(1)}% a year · beat holding in ${beat} of ${years.length} years)`}`)
    }
}
