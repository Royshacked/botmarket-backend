#!/usr/bin/env node
// THE BEST σ-STOP × REWARD : RISK FOR ONE NAME, ON EVERY HORIZON (Roy, 2026-11-21: "take KO and check the best combination
// of r:r and standard deviation for stop — in all horizons: day / short term swing / swing / long term"). An entry at
// every bar's close; the stop k × σ under it (k 0.5 … 3, 0.25 steps), σ = the recent σ of returns × √(the bars the trade
// can last); the target R × the risk (R 0.5 … 3) or none; 0.1% cost. Against holding over the same span. Per horizon: the
// top 10 (the difference from holding, % a year), the two halves, the years beaten, and whether the first half's best
// held in the second. An exploration — the best of 99 per horizon, picked after the fact.
//
//   DAY TRADE: hourly bars (5 years); an entry at each hourly close but the session's last; out by the session's last
//   close; σ = the last 60 INTRADAY hourly returns (the overnight one left out) × √(hours left).
//   SHORT-TERM SWING 10 · SWING 63 and 126 · LONG TERM 252 sessions: daily bars (10 years); σ = 60-day daily σ × √cap.
//
//   node scripts/lab-proteus-sd-grid.mjs [SYM=KO]

import fs from 'fs'

const SYM = (process.argv[2] ?? 'KO').toUpperCase()
const COST = 0.001, LOOK = 60
const KS = Array.from({ length: 11 }, (_, k) => 0.5 + k * 0.25)
const RS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, null]
const rl = (R) => (R == null ? 'none' : `1:${R}`)

const loadLine = (file) => fs.readFileSync(file, 'utf8').split('\n').find(l => l.startsWith(`{"symbol":"${SYM}"`))
const toRows = (line) => JSON.parse(line).b.map(([t, , high, low, close]) => ({ t, high, low, close })).sort((a, b) => a.t - b.t)

/** σ of `look` returns ending at each bar, from a list of the returns that count (null = skipped). */
function rollingSd(rets, look = LOOK) {
    const out = new Array(rets.length).fill(null), win = []
    for (let i = 0; i < rets.length; i++) {
        if (rets[i] != null) { win.push(rets[i]); if (win.length > look) win.shift() }
        if (win.length === look) { const m = win.reduce((s, x) => s + x, 0) / look; out[i] = Math.sqrt(win.reduce((s, x) => s + (x - m) ** 2, 0) / (look - 1)) }
    }
    return out
}

/**
 * One horizon's grid. `exitAt(i)` the last bar a trade from i may use; `span(i)` the bars it can last (for √); `part(i)` the
 * half; `year(i)`; `perYear` the bars in a year (to annualise per bar held).
 */
function grid(rows, sd, { exitAt, span, part, year, perYear, entries }) {
    const acc = {}
    const add = (key, i, r, h) => { for (const kk of [`${key}|all`, `${key}|${year(i)}`, `${key}|${part(i)}`]) { const a = (acc[kk] ??= [0, 0]); a[0] += r; a[1] += h } }
    for (const i of entries) {
        const end = exitAt(i)
        if (end == null || end <= i || sd[i] == null) continue
        const c = rows[i].close, s = sd[i] * Math.sqrt(span(i))
        for (const k of KS) for (const R of RS) {
            const stop = c * (1 - k * s), tgt = R == null ? null : c * (1 + R * k * s)
            let r = null, h = null
            for (let j = i + 1; j <= end; j++) {
                if (rows[j].low <= stop) { r = stop / c - 1 - COST; h = j - i; break }
                if (tgt != null && rows[j].high >= tgt) { r = tgt / c - 1 - COST; h = j - i; break }
            }
            if (r == null) { r = rows[end].close / c - 1 - COST; h = end - i }
            add(`${k}|${R}`, i, r, h)
        }
        add('hold', i, rows[end].close / c - 1 - COST, end - i)
    }
    const pd = (key) => acc[key][0] / acc[key][1]
    const years = [...new Set(Object.keys(acc).map(x => x.split('|').at(-1)).filter(x => /^\d{4}$/.test(x)))].sort()
    const vs = (key, p) => (pd(`${key}|${p}`) - pd(`hold|${p}`)) * perYear * 100
    const combos = KS.flatMap(k => RS.map(R => ({ k, R, key: `${k}|${R}` })))
    for (const x of combos) { x.all = vs(x.key, 'all'); x.o = vs(x.key, 'older'); x.r = vs(x.key, 'recent'); x.yrs = years.filter(y => pd(`${x.key}|${y}`) > pd(`hold|${y}`)).length }
    combos.sort((a, b) => b.all - a.all)
    return { combos, years, hold: pd('hold|all') * perYear * 100 }
}

function report(title, halves, g) {
    const { combos, years, hold } = g
    const rankR = [...combos].sort((a, b) => b.r - a.r), bo = [...combos].sort((a, b) => b.o - a.o)[0]
    console.log(`\n## ${title} — holding ${hold.toFixed(1)}% a year (per bar held, annualised) · ${combos.filter(x => x.all > 0).length} of ${combos.length} beat it`)
    console.log(`  rank  stop    r:r     vs hold      ${halves[0].padEnd(9)} ${halves[1].padEnd(9)} years beat`)
    for (const [j, x] of combos.slice(0, 10).entries()) console.log(`  ${String(j + 1).padStart(4)}  ${`${x.k}σ`.padEnd(6)}  ${rl(x.R).padEnd(6)}  ${x.all.toFixed(1).padStart(5)}%/yr   ${x.o.toFixed(1).padStart(6)}    ${x.r.toFixed(1).padStart(6)}    ${x.yrs}/${years.length}`)
    console.log(`  worst: ${combos.at(-1).k}σ ${rl(combos.at(-1).R)} ${combos.at(-1).all.toFixed(1)}%/yr`)
    console.log(`  best of ${halves[0]}: ${bo.k}σ ${rl(bo.R)} ${bo.o.toFixed(1)}%/yr → ${halves[1]} ${bo.r.toFixed(1)}%/yr (rank ${rankR.indexOf(bo) + 1} of ${combos.length})`)
}

console.log(`# ${SYM} — the best σ stop × reward:risk on every horizon; an entry at every bar; 0.1% cost; vs holding the same span`)

// DAY TRADE — hourly.
{
    const hl = loadLine('data/lab/hourly-5y.jsonl')
    if (!hl) console.log('\n(no hourly bars for the day trade)')
    else {
        const rows = toRows(hl)
        const day = (i) => new Date((rows[i].t - 5 * 3600) * 1000).toISOString().slice(0, 10)
        const last = new Array(rows.length).fill(null)
        for (let i = rows.length - 1, cur = null, d = null; i >= 0; i--) { if (day(i) !== d) { d = day(i); cur = i } last[i] = cur }
        const rets = rows.map((b, i) => (i && day(i) === day(i - 1) ? b.close / rows[i - 1].close - 1 : null))
        const sd = rollingSd(rets)
        const HALF = Date.parse('2024-05-01T00:00:00Z') / 1000
        const entries = rows.map((_, i) => i).filter(i => last[i] !== i)
        const g = grid(rows, sd, { entries, exitAt: (i) => last[i], span: (i) => last[i] - i, part: (i) => (rows[i].t < HALF ? 'older' : 'recent'), year: (i) => day(i).slice(0, 4), perYear: 252 * 7 })
        report(`DAY TRADE — hourly, out by the session's close (${rows.length} bars, from ${day(0)})`, ['2021–24', '2024–26'], g)
    }
}
// THE SWINGS AND LONG TERM — daily.
{
    const rows = toRows(loadLine('data/lab/screener-10y.jsonl'))
    const rets = rows.map((b, i) => (i ? b.close / rows[i - 1].close - 1 : null))
    const sd = rollingSd(rets)
    const HALF = Date.parse('2021-10-26T00:00:00Z') / 1000
    const year = (i) => new Date(rows[i].t * 1000).getUTCFullYear()
    for (const [name, cap] of [['SHORT-TERM SWING — 10 sessions', 10], ['SWING — 63 sessions (3 months)', 63], ['SWING — 126 sessions (6 months)', 126], ['LONG TERM — 252 sessions (a year)', 252]]) {
        const entries = rows.map((_, i) => i).filter(i => i + cap < rows.length)
        const g = grid(rows, sd, { entries, exitAt: (i) => i + cap, span: () => cap, part: (i) => (rows[i].t < HALF ? 'older' : 'recent'), year, perYear: 252 })
        report(name, ['2016–21', '2021–26'], g)
    }
}
