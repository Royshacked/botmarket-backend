// A MODEL ON THE RUN-UP — test K, the table (services/runupModel.service.js collectRunups): every run-up entry with its
// facts, one CSV row each, for the model and the rule search (scripts/lab-runup-ml.py). Declared in screener-lab.md §27.
//
//   node --max-old-space-size=6000 scripts/lab-runup-ml.mjs [--out=data/lab/runup-ml.csv]
//   python scripts/lab-runup-ml.py data/lab/runup-ml.csv
//
// Bars: the 2019–2023 and 3-year caches joined (screenerLab.data joinWindows); the extras from screener.extras.json. Offline.
import fs from 'fs'

const args = process.argv.slice(2)
const OUT = args.find(a => a.startsWith('--out='))?.slice(6) ?? 'data/lab/runup-ml.csv'
const { joinWindows, prepare } = await import('../services/screenerLab.data.js')
const { collectRunups, CSV_HEAD, csvRow } = await import('../services/runupModel.service.js')

let joined = joinWindows(JSON.parse(fs.readFileSync('data/lab/screener-2019-01-02_2023-10-06.json', 'utf8')), JSON.parse(fs.readFileSync('data/lab/screener-3y.json', 'utf8')))
console.log(`bars joined: ${Object.keys(joined.raw.names).length} names · scaled at the seam ${joined.scaled.length} · unmatched ${joined.unmatched.length}`)
const extras = JSON.parse(fs.readFileSync('data/lab/screener.extras.json', 'utf8'))
const data = prepare(joined.raw, extras)
joined = null
const from = data.spyDays[260]
console.log(`${data.names.size} names · SPY ${data.spyDays[0]} → ${data.spyDays.at(-1)} · entries from ${from}`)

const rows = collectRunups(data, { from }).sort((a, b) => a.day.localeCompare(b.day) || a.symbol.localeCompare(b.symbol))
fs.writeFileSync(OUT, [CSV_HEAD.join(','), ...rows.map(csvRow)].join('\n') + '\n')
// The sessions, for the block ranges (screenerLab blockRange cuts the calendar, not the trades' days).
fs.writeFileSync(OUT.replace(/\.csv$/, '.days.txt'), data.spyDays.filter(d => d >= from).join('\n') + '\n')
const live = rows.filter(r => r.live)
console.log(`${rows.length} run-up trades (${live.length} under the live rule) · ${rows[0]?.day ?? '—'} → ${rows.at(-1)?.day ?? '—'} → ${OUT}`)
process.exit(0)
