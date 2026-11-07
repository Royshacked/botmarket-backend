// GOOD EARNINGS, HELD TO THE NEXT EARNINGS — test N (services/holdToNext.service.js, declared in screener-lab.md §32).
//
//   node --max-old-space-size=6000 scripts/lab-hold-to-next.mjs                     (the S&P 500 as it was, 2019 → 2026-10)
//   node --max-old-space-size=6000 scripts/lab-hold-to-next.mjs --universe=screener (the Hotlist's names, 3 years)
//
// Offline: data/lab caches. Writes nothing.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const universe = process.argv.find(a => a.startsWith('--universe='))?.slice(11) ?? 'sp500'
const { holdTrades, holdBook, bookBlocks, holdVerdict } = await import('../services/holdToNext.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

let data, member = null, from, split
if (universe === 'sp500') {
    const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
    member = (sym, day) => memberOn(u.spans, sym, day)
    data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
    from = '2020-01-01'; split = '2024-01-01'
} else {
    data = await loadLabData({ name: 'screener', years: 3, extras: ['history'] })
    from = '2024-01-02'; split = '2025-10-23'
}
await closeDb()

const { trades, out } = holdTrades(data, { from, member })
const days = data.spyDays.filter(d => d >= from)
const f = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
const seen = (xs) => xs.filter(x => x != null)

function read(ts) {
    const book = holdBook(data, ts)
    return { whole: bookBlocks(book, days), before: bookBlocks(book, days.filter(d => d < split)), after: bookBlocks(book, days.filter(d => d >= split)) }
}
function line(label, ts) {
    if (!ts.length) return console.log(`  ${label.padEnd(30)} none`)
    const r = read(ts), net = ts.map(t => t.net)
    console.log(`  ${label.padEnd(30)} ${String(ts.length).padStart(6)} · trade: ${f(mean(ts.map(t => t.ret)))} vs SPY ${f(mean(ts.map(t => t.spy)))} · net ${f(mean(net))} median ${f(median(net))} beat SPY ${(ts.filter(t => t.net > 0).length / ts.length * 100).toFixed(0)}% · book/mo ${f(r.whole?.mean)} t ${r.whole?.t?.toFixed(2) ?? '—'} · before ${f(r.before?.mean)} after ${f(r.after?.mean)} · up to the window ${f(mean(seen(ts.map(t => t.body))))} last ${f(mean(seen(ts.map(t => t.last))))}`)
}

const known = trades.filter(t => t.rev_beat != null).length
console.log(`${universe}: ${trades.length} trades, entries ${from} →, split ${split}, ${days.length} sessions · median held ${median(trades.map(t => t.held))} sessions · revenue known ${(known / trades.length * 100).toFixed(0)}% · sold at a last bar ${trades.filter(t => t.ended).length}`)
console.log(`left out: ${JSON.stringify(out)}`)

const good = trades.filter(t => t.good)
console.log('\n── THE DECLARED PRIMARY, and its control')
line('GOOD (EPS >+2% + revenue beat)', good)
line('every report', trades)
console.log('\n── also shown (not the bar)')
line('good, market bought', good.filter(t => t.reacted === 'up'))
line('good, market sold', good.filter(t => t.reacted === 'down'))
line('EPS big beat (>+10%)', trades.filter(t => t.band === 'big beat'))
line('big beat + revenue + bought', trades.filter(t => t.band === 'big beat' && t.rev_beat === true && t.reacted === 'up'))
line('EPS in line', trades.filter(t => t.band === 'in line'))
line('EPS miss', trades.filter(t => t.band === 'miss'))
line('not good (everything else)', trades.filter(t => !t.good))
console.log('\n── good reports by the year they were bought')
for (const y of [...new Set(good.map(t => t.day.slice(0, 4)))].sort()) line(y, good.filter(t => t.day.startsWith(y)))

// Added after the first run, so a look and not part of the bar: long the good reports' book, short the rest.
const gb = holdBook(data, good), nb = holdBook(data, trades.filter(t => !t.good))
const diff = new Map(days.map(d => [d, { sum: (gb.get(d)?.n ? gb.get(d).sum / gb.get(d).n : 0) - (nb.get(d)?.n ? nb.get(d).sum / nb.get(d).n : 0), n: 1 }]))
const dr = (ds) => bookBlocks(diff, ds)
console.log(`\ngood minus not good, book/mo: whole ${f(dr(days)?.mean)} t ${dr(days)?.t?.toFixed(2) ?? '—'} · before ${f(dr(days.filter(d => d < split))?.mean)} · after ${f(dr(days.filter(d => d >= split))?.mean)}`)

const v = holdVerdict(read(good), read(trades))
console.log(`\nDECLARED BAR: above SPY in both periods ${v.beatsSpy} · above every report in both ${v.beatsAll} · t ≥ 2 ${v.significant} → ${v.pass ? 'PASS' : 'FAIL'}`)
process.exit(0)
