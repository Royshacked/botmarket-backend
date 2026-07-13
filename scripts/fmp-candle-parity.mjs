// FMP ↔ current-provider candle parity diff (Stage 2 step 2 of the Yahoo/Massive→FMP
// migration). For each symbol × timeframe it fetches the SAME window from FMP
// (getFmpCandles) and the current seam (massive.getTickerAggregates, which routes intraday
// → Yahoo and daily → Massive), then checks:
//   • timestamp alignment  — the critical tz gate; a consistent nonzero offset = a bug
//   • OHLC agreement       — close/high/low within tolerance on matched bars
//
// Run:  node scripts/fmp-candle-parity.mjs [SYM ...]
// Read-only, no writes. Exercises real provider quotas — keep the symbol set small.

import 'dotenv/config'
import { getFmpCandles } from '../providers/fmp.price.provider.js'
import { getTickerAggregates } from '../providers/massive.provider.js'

const SYMBOLS = process.argv.slice(2).length ? process.argv.slice(2) : ['AAPL', 'SPY', 'NVDA']
const TFS = [
    ['1min', { timeSpan: 'minute', multiplier: 1 },  3],
    ['15min',{ timeSpan: 'minute', multiplier: 15 }, 10],
    ['1hr',  { timeSpan: 'hour',   multiplier: 1 },  10],
    ['2hr',  { timeSpan: 'hour',   multiplier: 2 },  16],
    ['4hr',  { timeSpan: 'hour',   multiplier: 4 },  24],
    ['day',  { timeSpan: 'day',    multiplier: 1 },  90],
]

const iso   = t => new Date(t * 1000).toISOString().replace('.000Z', 'Z')
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }

function analyze(fmp, cur) {
    const curByTs = new Map(cur.map(b => [b.timestamp, b]))
    const curTs   = cur.map(b => b.timestamp)
    let exact = 0, maxClosePct = 0, maxHiLoPct = 0
    const deltas = []
    for (const f of fmp) {
        const c = curByTs.get(f.timestamp)
        if (c) {
            exact++
            maxClosePct = Math.max(maxClosePct, Math.abs(f.close - c.close) / (Math.abs(c.close) || 1))
            maxHiLoPct  = Math.max(maxHiLoPct,
                Math.abs(f.high - c.high) / (Math.abs(c.high) || 1),
                Math.abs(f.low  - c.low)  / (Math.abs(c.low)  || 1))
        } else if (curTs.length) {
            let best = null, bd = Infinity
            for (const t of curTs) { const dd = Math.abs(t - f.timestamp); if (dd < bd) { bd = dd; best = t } }
            deltas.push(f.timestamp - best)
        }
    }
    return { exact, total: fmp.length, curTotal: cur.length, offsetSec: median(deltas), maxClosePct, maxHiLoPct }
}

for (const sym of SYMBOLS) {
    console.log(`\n═══ ${sym} ═══`)
    for (const [label, opts, windowDays] of TFS) {
        const from = Date.now() - windowDays * 864e5
        const to   = Date.now()
        let fmp, cur
        try { fmp = await getFmpCandles(sym, { ...opts, from, to }) } catch (e) { console.log(`  ${label.padEnd(6)} FMP error: ${e.message}`); continue }
        if (fmp == null) { console.log(`  ${label.padEnd(6)} FMP: n/a (fallback timeframe)`); continue }
        try { cur = await getTickerAggregates(sym, { ...opts, from, to }) } catch (e) { console.log(`  ${label.padEnd(6)} current error: ${e.message}`); continue }
        cur = Array.isArray(cur) ? cur : []

        const a = analyze(fmp, cur)
        const off = a.offsetSec == null ? '—' : `${a.offsetSec >= 0 ? '+' : ''}${a.offsetSec}s (${(a.offsetSec / 3600).toFixed(2)}h)`
        const flag = a.exact === 0 && a.total && a.curTotal ? '  ⚠ NO exact-ts matches' : ''
        console.log(`  ${label.padEnd(6)} FMP=${String(a.total).padStart(4)} cur=${String(a.curTotal).padStart(4)} | exact-ts=${a.exact} | nearest-offset=${off} | Δclose≤${(a.maxClosePct*100).toFixed(3)}% Δhilo≤${(a.maxHiLoPct*100).toFixed(3)}%${flag}`)
        if (label === 'day' || a.exact === 0) {
            const f3 = fmp.slice(-3).map(b => iso(b.timestamp)).join(', ')
            const c3 = cur.slice(-3).map(b => iso(b.timestamp)).join(', ')
            console.log(`         FMP last3: ${f3}`)
            console.log(`         cur last3: ${c3}`)
        }
    }
}
process.exit(0)
