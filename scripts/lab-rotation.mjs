// WHICH RULE, WHEN — test L, the books (services/rotation.service.js): each library rule's daily excess over SPY, for
// the switchers (scripts/lab-rotation.py). Declared in screener-lab.md §29.
//
//   node --max-old-space-size=6000 scripts/lab-rotation.mjs
//   python scripts/lab-rotation.py
//
// Bars: the 2019–2023 and 3-year caches joined (screenerLab.data joinWindows); history and insiders from screener.extras.json. Offline.
import fs from 'fs'

const { joinWindows, prepare } = await import('../services/screenerLab.data.js')
const { libraryBooks } = await import('../services/rotation.service.js')

let joined = joinWindows(JSON.parse(fs.readFileSync('data/lab/screener-2019-01-02_2023-10-06.json', 'utf8')), JSON.parse(fs.readFileSync('data/lab/screener-3y.json', 'utf8')))
const { history, insiders } = JSON.parse(fs.readFileSync('data/lab/screener.extras.json', 'utf8'))
const data = prepare(joined.raw, { history, insiders })
joined = null
const days = data.spyDays.slice(260)
console.log(`${data.names.size} names · entries ${days[0]} → ${days.at(-1)}`)

const books = libraryBooks(data, days)
const lines = ['rule,day,ret,n']
for (const [rule, { trades, book }] of Object.entries(books)) {
    console.log(`  ${rule.padEnd(20)} ${String(trades).padStart(7)} trades · ${book.size} days with a position`)
    for (const d of days) { const b = book.get(d); lines.push(`${rule},${d},${b ? (b.sum / b.n).toFixed(5) : 0},${b?.n ?? 0}`) }
}
fs.writeFileSync('data/lab/rotation-daily.csv', lines.join('\n') + '\n')
// The market state each evening (spyRegimes), for step 3.
fs.writeFileSync('data/lab/rotation-regimes.csv', ['day,regime', ...days.map(d => `${d},${data.regimes.get(d) ?? ''}`)].join('\n') + '\n')
console.log('→ data/lab/rotation-daily.csv, data/lab/rotation-regimes.csv')
process.exit(0)
