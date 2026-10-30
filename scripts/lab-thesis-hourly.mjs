#!/usr/bin/env node
// THE THESIS LENS'S TEST 1c (Roy, 2026-10-30: "and if Talos would go in only when price is strong — would it affect?") —
// the reversal signals of test 1b, entered four ways on the SAME signals: the daily stand-in for strength, none, and a
// 1h / 4h stand-in for Talos's read. Declared in docs/design/stock-playbook.md §Test 1c before the run.
//
//   node scripts/lab-thesis-hourly.mjs [--sample N]   → fetches the 1-hour bars once (data/lab/thesis-h1.json, resumable), then the
//                                          table (data/lab/thesis-hourly.out.txt)

import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const L = await import('../services/thesisLab.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { costFor, MIN_ADV, MIN_PRICE } = await import('../services/screenerLab.service.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { getFmpCandles } = await import('../providers/fmp.price.provider.js')

const TO = '2026-10-26', HELD_OUT = '2025-10-23', WARMUP = 260, CACHE = 'data/lab/thesis-h1.json', PARALLEL = 4
const COVERAGE = 0.9
const O = L.DEFAULTS

const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: TO }, extras: [], member })
const days = data.spyDays.slice(WARMUP)

// The reversal signals with a plan (test 1b's primary), every covered name.
const sigs = []
for (const sym of Object.keys(u.spans)) {
    const s = data.names.get(sym)
    if (!s) continue
    const inIdx = days.filter(d => member(sym, d)), have = new Set(s.ind.date)
    if (!inIdx.length || inIdx.filter(d => have.has(d)).length / inIdx.length < COVERAGE) continue
    const a = L.atr(s.rows)
    for (const sig of L.controlSignals(s.rows, a, L.swings(s.rows, a, O.k), O)) {
        const i = sig.i, day = s.ind.date[i]
        if (sig.context !== 'reversal' || i < WARMUP || i + 1 >= s.rows.length || !member(sym, day) || s.rows[i].close < MIN_PRICE || !((s.ind.adv20[i] ?? 0) >= MIN_ADV)) continue
        const p = L.plan(sig, a, O)
        if (p) sigs.push({ sym, i, day, p })
    }
}
console.log(`${sigs.length} reversal signals with a plan`)

// The 1-hour bars, from the session after the signal through the wait — fetched once, `[day, open, high, low, close]`.
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {}
const etDay = (sec) => new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
// `--sample N` (Roy, 2026-10-30: option B) — the signals already fetched plus N more drawn at random (seeded) from the rest,
// instead of all ~14k (FMP allows ~80 hourly reads a minute: ~2 hours, and the laptop ran out of memory on the way).
const sampleArg = process.argv.indexOf('--sample')
const sampleN = sampleArg > 0 ? Number(process.argv[sampleArg + 1]) : null
let todo = sigs.filter(g => !(`${g.sym}|${g.day}` in cache))
if (sampleN != null) {
    const rand = L.rng(11)
    todo = todo.map(g => [rand(), g]).sort((a, b) => a[0] - b[0]).slice(0, sampleN).map(([, g]) => g)
    const keep = new Set([...todo, ...sigs.filter(g => `${g.sym}|${g.day}` in cache)])
    sigs.splice(0, sigs.length, ...sigs.filter(g => keep.has(g)))
    console.log(`sample: ${sigs.length - todo.length} already fetched + ${todo.length} at random → ${sigs.length} signals`)
}
let done = 0, failed = 0
async function fetchOne(g) {
    const date = data.names.get(g.sym).ind.date
    const from = date[g.i + 1], to = date[Math.min(date.length - 1, g.i + O.wait)]
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await getFmpCandles(g.sym, { timeSpan: 'hour', multiplier: 1, from: Date.parse(from), to: Date.parse(to) })
            cache[`${g.sym}|${g.day}`] = (Array.isArray(r) ? r : []).map(b => [etDay(b.timestamp), b.open, b.high, b.low, b.close])
                .filter(b => b[0] >= from && b[0] <= to)
            return
        } catch (err) {
            if (err?.status === 429) { await new Promise(res => setTimeout(res, 65_000)); continue }
            if (attempt === 3) { failed++; cache[`${g.sym}|${g.day}`] = [] }
        }
    }
}
for (let q = 0; q < todo.length; q += PARALLEL) {
    await Promise.all(todo.slice(q, q + PARALLEL).map(fetchOne))
    done += Math.min(PARALLEL, todo.length - q)
    if (done % 200 < PARALLEL || done === todo.length) { fs.writeFileSync(CACHE, JSON.stringify(cache)); console.log(`  hourly ${done}/${todo.length} (${failed} failed)`) }
}

const out = []
const say = (line = '') => { console.log(line); out.push(line) }
const f = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2))
const line = (label, s, of) => (s.n
    ? `${label.padEnd(30)} ${String(s.n).padStart(5)} (${((s.n / of) * 100).toFixed(0).padStart(2)}% of signals)  hit ${(s.hit * 100).toFixed(1).padStart(5)}%  mean ${f(s.meanR)}R (${f(s.lo)} … ${f(s.hi)})  median ${f(s.medianR)}R  ${s.days}d`
    : `${label.padEnd(30)}     0`)

// The four entries on the signals that have hourly bars.
const ways = {
    'daily strength (test 1b)': (g, rows) => L.play(rows, g.i, g.p, O),
    'no strength': (g, rows) => L.play(rows, g.i, g.p, { ...O, strength: false }),
    '1h strength': (g, rows, date, h1) => L.playIntraday(rows, date, g.i, h1, g.p, O),
    '4h strength': (g, rows, date, h1) => L.playIntraday(rows, date, g.i, L.toFourHour(h1), g.p, O),
}
const usable = sigs.filter(g => cache[`${g.sym}|${g.day}`]?.length)
say(`Thesis test 1c — reversal signals ${sigs.length}, with hourly bars ${usable.length} · held out from ${HELD_OUT}`)
for (const [name, enter] of Object.entries(ways)) {
    const trades = []
    for (const g of usable) {
        const s = data.names.get(g.sym), date = s.ind.date
        const h1 = cache[`${g.sym}|${g.day}`].map(([day, open, high, low, close]) => ({ day, open, high, low, close }))
        const t = enter(g, s.rows, date, h1)
        if (!t || t.reason === 'open') continue
        trades.push({ r: L.inR(t, g.p.S, costFor(s.ind.adv20[g.i]), g.p.E), win: t.reason === 'target', days: t.k - t.m, month: date[t.m].slice(0, 7), held: g.day >= HELD_OUT })
    }
    const pre = usable.filter(g => g.day < HELD_OUT).length, post = usable.length - pre
    say(line(`${name} · before`, L.summarize(trades.filter(t => !t.held)), pre))
    say(line(`${name} · held out`, L.summarize(trades.filter(t => t.held)), post))
}
fs.writeFileSync('data/lab/thesis-hourly.out.txt', out.join('\n') + '\n')
console.log('→ data/lab/thesis-hourly.out.txt')
process.exit(0)
