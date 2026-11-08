// THE BROAD UNIVERSE'S DATA (screener-lab.md §48, test Y), in three small resumable steps — never the whole set in memory
// at once (the machine's memory has stopped long runs before):
//
//   node scripts/lab-broad-fetch.mjs --bars      daily bars FROM → TO for every name → data/lab/broad-bars.jsonl
//   node scripts/lab-broad-fetch.mjs --prune     the names that ever pass the size floor → data/lab/broad-eligible.json
//   node scripts/lab-broad-fetch.mjs --history   FMP's earnings history for those → data/lab/broad-history.jsonl
//   node scripts/lab-broad-fetch.mjs --spy       SPY from 2023-06 (test Z, its 200-day) → data/lab/broad-spy.json
//
// One JSON line a name; a name already in a file is skipped on a rerun. Paced at DAILY_SCREENER_RPM (60 a minute).
import dns from 'dns'
import fs from 'fs'
import readline from 'readline'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { getFmpCandles, fmpGet } = await import('../providers/fmp.price.provider.js')
const { config } = await import('../services/config.js')

// Bars from ~75 sessions before the first entry: holdTrades skips a report in a name's first 61 bars, and the 20-day
// volume wants its own; to the lab's last day.
export const FROM = '2024-07-15', TO = '2026-10-26', FIRST_ENTRY = '2024-11-01'
export const FLOOR = { price: 5, adv: 10e6 }
const BARS = 'data/lab/broad-bars.jsonl', ELIGIBLE = 'data/lab/broad-eligible.json', HISTORY = 'data/lab/broad-history.jsonl'
const gap = Math.ceil(60_000 / config.dailyScreenerRpm)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const doneIn = (file) => new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => l.slice(0, 200).match(/"symbol":"([^"]+)"/)?.[1]) : [])

async function each(symbols, file, read, label) {
    const done = doneIn(file), todo = symbols.filter(s => !done.has(s))
    console.log(`${label}: ${symbols.length} · ${done.size} done · ${todo.length} to read (~${Math.ceil(todo.length * gap / 60000)} min)`)
    let n = 0, miss = 0
    for (const symbol of todo) {
        let row
        for (let a = 1; ; a++) {
            try { row = await read(symbol); break } catch (err) {
                if (err.status === 404 || err.status === 402 || a >= 3) { row = { miss: String(err.status ?? err.message) }; break }
                await sleep(10_000 * a)
            }
        }
        if (!row || row.miss) miss++
        fs.appendFileSync(file, JSON.stringify({ symbol, ...(row ?? { miss: 'empty' }) }) + '\n')
        if (++n % 100 === 0) console.log(`  ${n}/${todo.length} · missing ${miss}`)
        await sleep(gap)
    }
    console.log(`${label}: done · ${n} read · missing ${miss}`)
}

const arg = process.argv[2]
if (arg === '--bars') {
    const u = JSON.parse(fs.readFileSync('data/lab/broad-universe.json', 'utf8'))
    const syms = ['SPY', ...u.names.map(x => x.symbol)]
    await each(syms, BARS, async (s) => {
        const bars = await getFmpCandles(s, { timeSpan: 'day', multiplier: 1, from: Date.parse(FROM), to: Date.parse(`${TO}T23:59:59Z`) })
        return bars?.length ? { b: bars.map(r => [r.timestamp, r.open, r.high, r.low, r.close, r.volume]) } : { miss: 'no bars' }
    }, 'bars')
} else if (arg === '--prune') {
    // A name is kept if on any session from FIRST_ENTRY its close is $5+ and its 20-day dollar volume $10M+.
    const keep = [], why = { no_bars: 0, thin: 0 }
    const rl = readline.createInterface({ input: fs.createReadStream(BARS) })
    for await (const line of rl) {
        if (!line) continue
        const r = JSON.parse(line)
        if (r.symbol === 'SPY') continue
        if (!r.b?.length) { why.no_bars++; continue }
        const first = Date.parse(FIRST_ENTRY) / 1000
        let ok = false
        for (let k = 20; k < r.b.length && !ok; k++) {
            if (r.b[k][0] < first) continue
            let dv = 0
            for (let z = k - 20; z < k; z++) dv += r.b[z][4] * r.b[z][5]
            if (r.b[k - 1][4] >= FLOOR.price && dv / 20 >= FLOOR.adv) ok = true
        }
        if (ok) keep.push(r.symbol); else why.thin++
    }
    fs.writeFileSync(ELIGIBLE, JSON.stringify({ floor: FLOOR, from: FIRST_ENTRY, symbols: keep }))
    console.log(`eligible: ${keep.length} · dropped: no bars ${why.no_bars}, never over the floor ${why.thin} → ${ELIGIBLE}`)
} else if (arg === '--history') {
    const { symbols } = JSON.parse(fs.readFileSync(ELIGIBLE, 'utf8'))
    await each(symbols, HISTORY, async (s) => {
        const rows = (await fmpGet(`/earnings?symbol=${encodeURIComponent(s)}&limit=40`, { label: `FMP earnings ${s}` })) ?? []
        return { h: rows.map(e => ({ symbol: s, date: e.date, epsActual: e.epsActual, epsEstimated: e.epsEstimated, revenueActual: e.revenueActual, revenueEstimated: e.revenueEstimated })) }
    }, 'history')
} else if (arg === '--spy') {
    // SPY back to 2023-06 (test Z, §49): its 200-day average from the first entry on.
    const bars = await getFmpCandles('SPY', { timeSpan: 'day', multiplier: 1, from: Date.parse('2023-06-01'), to: Date.parse(`${TO}T23:59:59Z`) })
    fs.writeFileSync('data/lab/broad-spy.json', JSON.stringify(bars.map(r => [r.timestamp, r.open, r.high, r.low, r.close, r.volume])))
    console.log(`SPY: ${bars.length} bars → data/lab/broad-spy.json`)
} else console.log('--bars | --prune | --history | --spy')
process.exit(0)
