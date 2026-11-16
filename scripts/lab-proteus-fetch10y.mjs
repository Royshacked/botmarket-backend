#!/usr/bin/env node
// TEN YEARS OF DAILY BARS for the screener's names (proteus.md §10.4, Roy 2026-11-16: "yes start the fetch") — the
// profile's own daily depth (behaviourProfile.service: ~10 years, one call), for the indicator-values lab. The 4-year
// screener-3y.json left most per-name verdicts `thin`.
//
//   node scripts/lab-proteus-fetch10y.mjs   → data/lab/screener-10y.jsonl  (one line a name; a rerun skips names done)
//
// Paced at DAILY_SCREENER_RPM (60 a minute), lab-broad-fetch.mjs's rule; 3 tries, a 404/402 is a miss.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { getFmpCandles } = await import('../providers/fmp.price.provider.js')
const { config } = await import('../services/config.js')

const FROM = '2016-10-26', TO = '2026-10-26'
const OUT = 'data/lab/screener-10y.jsonl'
const gap = Math.ceil(60_000 / config.dailyScreenerRpm)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const names = Object.keys(JSON.parse(fs.readFileSync('data/lab/screener-3y.json', 'utf8')).names)
const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => l.slice(0, 200).match(/"symbol":"([^"]+)"/)?.[1]) : [])
const todo = ['SPY', ...names].filter(s => !done.has(s))
console.log(`10-year daily: ${names.length + 1} · ${done.size} done · ${todo.length} to read (~${Math.ceil(todo.length * gap / 60000)} min)`)

let n = 0, miss = 0
for (const symbol of todo) {
    let row
    for (let a = 1; ; a++) {
        try {
            const bars = await getFmpCandles(symbol, { timeSpan: 'day', multiplier: 1, from: Date.parse(FROM), to: Date.parse(`${TO}T23:59:59Z`) })
            row = bars?.length ? { b: bars.map(r => [r.timestamp, r.open, r.high, r.low, r.close, r.volume]) } : { miss: 'no bars' }
            break
        } catch (err) {
            if (err.status === 404 || err.status === 402 || a >= 3) { row = { miss: String(err.status ?? err.message) }; break }
            await sleep(10_000 * a)
        }
    }
    if (row.miss) miss++
    fs.appendFileSync(OUT, JSON.stringify({ symbol, ...row }) + '\n')
    if (++n % 100 === 0) console.log(`  ${n}/${todo.length} · missing ${miss}`)
    await sleep(gap)
}
console.log(`done · ${n} read · missing ${miss} → ${OUT}`)
process.exit(0)
