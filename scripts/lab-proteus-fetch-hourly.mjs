#!/usr/bin/env node
// HOURLY BARS FOR THE LABS (proteus.md §10.15c, Roy 2026-11-21: "run it on hourly bars with 100 stocks"): 5 years of
// 1-hour bars for the first N names of the 10-year daily file (SPY left out), through the candle router Proteus uses,
// in 60-day pages (its own paging), a few names at a time. Resumable: names already in the output are skipped.
//
//   node scripts/lab-proteus-fetch-hourly.mjs [N=100] [YEARS=5]   → data/lab/hourly-5y.jsonl  (one line a name)

import 'dotenv/config'
import fs from 'fs'
import readline from 'readline'
import { getTickerAggregates } from '../providers/candles.provider.js'

const N = Number(process.argv[2] ?? 100), YEARS = Number(process.argv[3] ?? 5)
const OUT = 'data/lab/hourly-5y.jsonl', DAY = 864e5, PAGE = 60, PARALLEL = 3
const now = Date.now()

async function names() {
    const out = []
    const rl = readline.createInterface({ input: fs.createReadStream('data/lab/screener-10y.jsonl'), crlfDelay: Infinity })
    for await (const line of rl) {
        const sym = line.slice(11, line.indexOf('"', 11))
        if (sym === 'SPY') continue
        out.push(sym)
        if (out.length >= N) { rl.close(); break }
    }
    return out
}

const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).symbol) : [])
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function fetchName(sym) {
    const byTs = new Map()
    let failed = 0
    for (let to = now; to > now - YEARS * 365 * DAY; to -= PAGE * DAY) {
        for (const wait of [0, 2000, 8000]) {
            if (wait) await sleep(wait)
            try {
                for (const b of (await getTickerAggregates(sym, { timeSpan: 'hour', multiplier: 1, from: to - PAGE * DAY, to })) ?? []) byTs.set(b.timestamp, b)
                break
            } catch (err) { if (wait === 8000) { failed++; console.warn(`  ${sym} page to ${new Date(to).toISOString().slice(0, 10)} failed: ${err.message}`) } }
        }
    }
    const b = [...byTs.values()].sort((x, y) => x.timestamp - y.timestamp)
        .map(x => [x.timestamp < 1e12 ? x.timestamp : Math.round(x.timestamp / 1000), x.open, x.high, x.low, x.close, x.volume ?? 0])
    return { symbol: sym, failed, b }
}

const list = (await names()).filter(s => !done.has(s))
console.log(`${list.length} names to fetch (${done.size} already done), ${YEARS} years of 1-hour bars each`)
for (let k = 0; k < list.length; k += PARALLEL) {
    const batch = await Promise.all(list.slice(k, k + PARALLEL).map(fetchName))
    for (const r of batch) {
        fs.appendFileSync(OUT, JSON.stringify(r) + '\n')
        console.log(`  ${r.symbol}: ${r.b.length} bars${r.b.length ? ` (${new Date(r.b[0][0] * 1000).toISOString().slice(0, 10)} →)` : ''}${r.failed ? `, ${r.failed} pages failed` : ''}`)
    }
}
console.log(`→ ${OUT}`)
process.exit(0)
