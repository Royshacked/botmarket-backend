// GOOD EARNINGS AND A RAISED GUIDANCE, HELD TO THE NEXT EARNINGS — test O (services/guidance8k.service.js + holdToNext,
// declared in screener-lab.md §33). Test N's trades, each with the guidance its earnings release stated.
//
//   node --max-old-space-size=6000 scripts/lab-guidance-hold.mjs            (after scripts/lab-guidance-fetch.mjs)
//   node scripts/lab-guidance-hold.mjs --check=60                            (no returns: N releases at random, to grade by hand)
//
// Offline: data/lab caches + data/lab/guidance-8k.jsonl.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { guidanceDirection, sentenceDirection } = await import('../services/guidance8k.service.js')
const rows = fs.readFileSync('data/lab/guidance-8k.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const guidanceOf = new Map(rows.map(r => [`${r.symbol} ${r.report}`, r.miss ? `missing: ${r.miss}` : guidanceDirection(r)]))

const check = Number(process.argv.find(a => a.startsWith('--check='))?.slice(8) ?? 0)
if (check) {
    // A fixed seed, so the same releases come back to grade.
    let seed = 20261107
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const read = rows.filter(r => !r.miss)
    const pick = new Set()
    while (pick.size < Math.min(check, read.length)) pick.add(Math.floor(rand() * read.length))
    for (const n of pick) {
        const r = read[n]
        console.log(`\n#${n} ${r.symbol} ${r.report} → ${guidanceDirection(r).toUpperCase()}   [${r.exhibit}]`)
        console.log(`  HEAD ${r.lead.slice(0, 260)}`)
        for (const s of r.lines.filter(l => sentenceDirection(l) || /\b(guidance|outlook)\b/i.test(l)).slice(0, 6)) console.log(`  ${(sentenceDirection(s) ?? '·').padEnd(5)} ${s.slice(0, 230)}`)
    }
    const tally = {}
    for (const v of guidanceOf.values()) tally[v] = (tally[v] ?? 0) + 1
    console.log(`\n${rows.length} releases: ${JSON.stringify(tally)}`)
    process.exit(0)
}

const { holdTrades, holdBook, bookBlocks, holdVerdict } = await import('../services/holdToNext.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
await closeDb()
const FROM = '2020-01-01', SPLIT = '2024-01-01'
const trades = holdTrades(data, { from: FROM, member }).trades
for (const t of trades) t.guidance = guidanceOf.get(`${t.symbol} ${data.names.get(t.symbol).ind.date[t.i - 2]}`) ?? 'not fetched'
const days = data.spyDays.filter(d => d >= FROM)

const f = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
const read = (ts) => { const b = holdBook(data, ts); return { whole: bookBlocks(b, days), before: bookBlocks(b, days.filter(d => d < SPLIT)), after: bookBlocks(b, days.filter(d => d >= SPLIT)) } }
function line(label, ts) {
    if (!ts.length) return console.log(`  ${label.padEnd(32)} none`)
    const r = read(ts), net = ts.map(t => t.net)
    console.log(`  ${label.padEnd(32)} ${String(ts.length).padStart(6)} · trade ${f(mean(ts.map(t => t.ret)))} vs SPY ${f(mean(ts.map(t => t.spy)))} · net ${f(mean(net))} median ${f(median(net))} beat SPY ${(ts.filter(t => t.net > 0).length / ts.length * 100).toFixed(0)}% · book/mo ${f(r.whole?.mean)} t ${r.whole?.t?.toFixed(2) ?? '—'} · before ${f(r.before?.mean)} after ${f(r.after?.mean)}`)
}

const tally = {}
for (const t of trades) tally[t.guidance] = (tally[t.guidance] ?? 0) + 1
console.log(`${trades.length} trades (test N's), entries ${FROM} →, split ${SPLIT} · guidance: ${JSON.stringify(tally)}`)
const primary = trades.filter(t => t.good && t.guidance === 'raise')
console.log('\n── THE DECLARED PRIMARY, and its control')
line('GOOD + RAISED GUIDANCE', primary)
line('every report', trades)
console.log('\n── also shown (not the bar)')
line('raised guidance, any report', trades.filter(t => t.guidance === 'raise'))
line('good + maintained', trades.filter(t => t.good && t.guidance === 'maintain'))
line('good + cut', trades.filter(t => t.good && t.guidance === 'cut'))
line('good + numbers only', trades.filter(t => t.good && t.guidance === 'numbers'))
line('good + nothing stated', trades.filter(t => t.good && t.guidance === 'none'))
line('cut guidance, any report', trades.filter(t => t.guidance === 'cut'))
line('maintained, any report', trades.filter(t => t.guidance === 'maintain'))
line('mixed', trades.filter(t => t.guidance === 'mixed'))
line('raised + market bought', trades.filter(t => t.guidance === 'raise' && t.reacted === 'up'))
console.log('\n── good + raised, by the year bought (per trade only)')
for (const y of [...new Set(primary.map(t => t.day.slice(0, 4)))].sort()) {
    const ts = primary.filter(t => t.day.startsWith(y))
    console.log(`  ${y} ${String(ts.length).padStart(5)} · net ${f(mean(ts.map(t => t.net)))} median ${f(median(ts.map(t => t.net)))} beat SPY ${(ts.filter(t => t.net > 0).length / ts.length * 100).toFixed(0)}%`)
}
const v = holdVerdict(read(primary), read(trades))
console.log(`\nDECLARED BAR: above SPY in both periods ${v.beatsSpy} · above every report in both ${v.beatsAll} · t ≥ 2 ${v.significant} → ${v.pass ? 'PASS' : 'FAIL'}`)
process.exit(0)
