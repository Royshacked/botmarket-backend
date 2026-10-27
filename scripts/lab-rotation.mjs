// WHICH RULE, WHEN — test L, the books (services/rotation.service.js): each library rule's daily excess over SPY, for
// the switchers (scripts/lab-rotation.py). Declared in screener-lab.md §29; the S&P 500 as it was, §30.
//
//   node --max-old-space-size=6000 scripts/lab-rotation.mjs                  (the screener's names — today's)
//   node --max-old-space-size=6000 scripts/lab-rotation.mjs --universe=sp500 (the S&P 500 as it was, AND as it is today)
//   python scripts/lab-rotation.py [--tag=sp500 | --tag=sp500-today]
//
// screener: the 2019–2023 and 3-year caches joined (screenerLab.data joinWindows), offline. sp500: data/lab/sp500-universe.json
// (scripts/lab-sp500-universe.mjs) — bars, history and insiders read from FMP once, then cached.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const universe = process.argv.find(a => a.startsWith('--universe='))?.slice(11) ?? 'screener'
const { joinWindows, prepare, loadLabData, sectorStats } = await import('../services/screenerLab.data.js')
const { libraryBooks } = await import('../services/rotation.service.js')
const { memberOn } = await import('../services/sp500History.service.js')

/** The members' share of their sessions in the index that have a bar — under it, the ticker is not the company (reused) or FMP lacks it. */
const COVERAGE = 0.9

function write(tag, data, days, opts) {
    const books = libraryBooks(data, days, undefined, opts)
    const lines = ['rule,day,ret,n']
    for (const [rule, { trades, book }] of Object.entries(books)) {
        console.log(`  ${rule.padEnd(20)} ${String(trades).padStart(7)} trades · ${book.size} days with a position`)
        for (const d of days) { const b = book.get(d); lines.push(`${rule},${d},${b ? (b.sum / b.n).toFixed(5) : 0},${b?.n ?? 0}`) }
    }
    const file = `data/lab/rotation-daily${tag ? `-${tag}` : ''}.csv`
    fs.writeFileSync(file, lines.join('\n') + '\n')
    console.log(`→ ${file}`)
}

let data
if (universe === 'sp500') {
    const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
    const member = (sym, day) => memberOn(u.spans, sym, day)
    data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member,
        onProgress: (label, k, n) => console.log(`  ${label} ${k}/${n}`) })
    const days = data.spyDays.slice(260)
    // A name counts only if its bars cover its sessions in the index (within the span).
    const covered = new Set(), short = []
    for (const sym of Object.keys(u.spans)) {
        const inIdx = days.filter(d => member(sym, d))
        if (!inIdx.length) continue
        const s = data.names.get(sym), have = s ? new Set(s.ind.date) : new Set()
        const share = inIdx.filter(d => have.has(d)).length / inIdx.length
        if (share >= COVERAGE) covered.add(sym)
        else short.push(`${sym} ${(share * 100).toFixed(0)}% (${inIdx[0]} → ${inIdx.at(-1)})`)
    }
    const today = new Set(Object.entries(u.spans).filter(([, sp]) => sp.at(-1)[1] == null).map(([s]) => s))
    console.log(`${data.names.size} names with bars · in the index during ${days[0]} → ${days.at(-1)}: ${covered.size + short.length} · covered ${covered.size} · left out ${short.length}`)
    for (const x of short) console.log(`  left out ${x}`)
    console.log('\nTHE S&P 500 AS IT WAS (point in time)')
    write('sp500', data, days, { keep: (t) => covered.has(t.symbol) && member(t.symbol, t.day) })
    // The survivor version: today's members, on every day — the bias the lab's own universe carries.
    data.sectorDay = sectorStats(data.names, (sym) => today.has(sym))
    console.log('\nTHE S&P 500 AS IT IS TODAY, on every day (survivors)')
    write('sp500-today', data, days, { keep: (t) => today.has(t.symbol) })
} else {
    let joined = joinWindows(JSON.parse(fs.readFileSync('data/lab/screener-2019-01-02_2023-10-06.json', 'utf8')), JSON.parse(fs.readFileSync('data/lab/screener-3y.json', 'utf8')))
    const { history, insiders } = JSON.parse(fs.readFileSync('data/lab/screener.extras.json', 'utf8'))
    data = prepare(joined.raw, { history, insiders })
    joined = null
    const days = data.spyDays.slice(260)
    console.log(`${data.names.size} names · entries ${days[0]} → ${days.at(-1)}`)
    write('', data, days)
}
// The market state each evening (spyRegimes), for step 3 — SPY's, the same for every universe.
const days = data.spyDays.slice(260)
fs.writeFileSync('data/lab/rotation-regimes.csv', ['day,regime', ...days.map(d => `${d},${data.regimes.get(d) ?? ''}`)].join('\n') + '\n')
process.exit(0)
