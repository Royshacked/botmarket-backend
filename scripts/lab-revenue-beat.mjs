// A REVENUE BEAT OF 10%+, HELD TO THE NEXT REPORT — test P (declared in screener-lab.md §34, before the run). On names
// the description never saw: the screener's names that were never in the S&P 500. Each window in its own process (both
// at once is ~2.5 GB), then the verdict over both.
//
//   node --max-old-space-size=6000 scripts/lab-revenue-beat.mjs --window=old     (2019-01 → 2023-10)
//   node --max-old-space-size=6000 scripts/lab-revenue-beat.mjs --window=new     (2023-10 → 2026-10)
//   node scripts/lab-revenue-beat.mjs --verdict                                   (reads both → the bar)
//
// Offline: data/lab caches. Writes data/lab/revenue-beat-<window>.json (the books' blocks).
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const MIN = 10
const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const out = (w) => `data/lab/revenue-beat-${w}.json`

if (process.argv.includes('--verdict')) {
    const [a, b] = ['old', 'new'].map(w => JSON.parse(fs.readFileSync(out(w), 'utf8')))
    const stats = (xs) => {
        const m = xs.reduce((s, x) => s + x, 0) / xs.length
        const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
        return { mean: m, t: sd > 0 ? m / (sd / Math.sqrt(xs.length)) : null, n: xs.length }
    }
    const sig = stats([...a.blocks.signal, ...b.blocks.signal]), all = stats([...a.blocks.all, ...b.blocks.all])
    const beatsSpy = a.book.signal > 0 && b.book.signal > 0
    const beatsAll = a.book.signal > a.book.all && b.book.signal > b.book.all
    const significant = sig.t != null && sig.t >= 2
    console.log(`signal book/mo: old ${f2(a.book.signal)} · new ${f2(b.book.signal)} · both ${f2(sig.mean)} t ${sig.t?.toFixed(2)} (${sig.n} blocks)`)
    console.log(`every report:   old ${f2(a.book.all)} · new ${f2(b.book.all)} · both ${f2(all.mean)} t ${all.t?.toFixed(2)}`)
    console.log(`\nDECLARED BAR: above SPY in both windows ${beatsSpy} · above every report in both ${beatsAll} · t ≥ 2 ${significant} → ${beatsSpy && beatsAll && significant ? 'PASS' : 'FAIL'}`)
    process.exit(0)
}

const w = process.argv.find(x => x.startsWith('--window='))?.slice(9)
if (w !== 'old' && w !== 'new') { console.log('--window=old | --window=new | --verdict'); process.exit(1) }
const { holdTrades, holdBook, bookBlocks } = await import('../services/holdToNext.service.js')
const { prepare } = await import('../services/screenerLab.data.js')

const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const everSp = new Set(Object.keys(u.spans))
const file = w === 'old' ? 'data/lab/screener-2019-01-02_2023-10-06.json' : 'data/lab/screener-3y.json'
let raw = JSON.parse(fs.readFileSync(file, 'utf8'))
for (const sym of Object.keys(raw.names)) if (everSp.has(sym)) delete raw.names[sym]
const { history, insiders } = JSON.parse(fs.readFileSync('data/lab/screener.extras.json', 'utf8'))
const data = prepare(raw, { history, insiders })
raw = null
// The windows do not overlap: the 3-year cache starts in 2022, so its entries start where the old window ends (§34).
const from = w === 'old' ? '2019-06-01' : '2023-10-09'
const trades = holdTrades(data, { from }).trades
for (const t of trades) {
    const rep = data.names.get(t.symbol).reports.get(data.names.get(t.symbol).ind.date[t.i - 2])
    const a = Number(rep?.revenueActual), e = Number(rep?.revenueEstimated)
    t.rev = a > 0 && e > 0 ? (a / e - 1) * 100 : null
}
const days = data.spyDays.filter(d => d >= from)
const signal = trades.filter(t => t.rev != null && t.rev >= MIN)
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((p, q) => p - q); return v[Math.floor(v.length / 2)] }
// The blocks themselves, so --verdict can take t over both windows.
function blocksOf(ts) {
    const b = holdBook(data, ts), sums = []
    for (let n = 0; n + 21 <= days.length; n += 21) {
        let s = 0
        for (const d of days.slice(n, n + 21)) { const x = b.get(d); if (x?.n) s += x.sum / x.n }
        sums.push(s)
    }
    return { sums, read: bookBlocks(b, days) }
}
const S = blocksOf(signal), A = blocksOf(trades)
const line = (label, ts, r) => console.log(`  ${label.padEnd(26)} ${String(ts.length).padStart(5)} · stock ${f2(mean(ts.map(t => t.ret)))} vs SPY ${f2(mean(ts.map(t => t.spy)))} · net ${f2(mean(ts.map(t => t.net)))} median ${f2(median(ts.map(t => t.net)))} beat SPY ${(ts.filter(t => t.net > 0).length / ts.length * 100).toFixed(0)}% · book/mo ${f2(r.read?.mean)} t ${r.read?.t?.toFixed(2)}`)
console.log(`window ${w}: ${data.names.size} names never in the S&P 500 · entries ${from} → ${days.at(-1)} · ${trades.length} holds · revenue known ${(trades.filter(t => t.rev != null).length / trades.length * 100).toFixed(0)}%`)
line(`revenue beat ≥ +${MIN}%`, signal, S)
line('every report', trades, A)
const sorted = [...signal].sort((p, q) => q.net - p.net)
console.log(`  signal without its best 1% (${Math.max(1, Math.round(signal.length / 100))}): ${f2(mean(sorted.slice(Math.max(1, Math.round(signal.length / 100))).map(t => t.net)))} · the 5 best: ${sorted.slice(0, 5).map(t => `${t.symbol} ${t.day.slice(0, 7)} ${f2(t.net, 0)}`).join(' · ')}`)
fs.writeFileSync(out(w), JSON.stringify({ window: w, from, n: { signal: signal.length, all: trades.length }, book: { signal: S.read?.mean, all: A.read?.mean }, blocks: { signal: S.sums, all: A.sums } }))
process.exit(0)
