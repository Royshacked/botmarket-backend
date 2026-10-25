// THE WINNERS STUDY (screenerLab.service winnersStudy) — the last N weeks' biggest up moves against SPY, and what they
// shared the evening before compared with every other name that week (Roy, 2026-10-25).
//
//   node scripts/lab-winners.mjs [weeks=24] [top=20] [min=10] [--down]
//
// Offline on the screener universe's one-year cache (data/lab/screener.json + its earnings history); writes the whole
// study to data/lab/winners.json.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [weeks = 24, top = 20, min = 10] = process.argv.slice(2).filter(a => !a.startsWith('--')).map(Number)
const side = process.argv.includes('--down') ? 'down' : 'up'
const { winnersStudy } = await import('../services/screenerLab.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { closeDb } = await import('../providers/mongodb.provider.js')
const data = await loadLabData({ name: 'screener', extras: ['history'] })
await closeDb()
const r = winnersStudy(data, { weeks, top, min, side })
fs.writeFileSync(`data/lab/${side === 'down' ? 'losers' : 'winners'}.json`, JSON.stringify(r, null, 1))

console.log(`${r.weeks.length} weeks · ${r.winners} winners (top ${top}, ${min}%+ over SPY) among ${r.name_weeks} name-weeks\n`)
for (const w of r.weeks) {
    const fromReport = w.winners.filter(x => x.best_day_report).length
    console.log(`${w.start} → ${w.end}  SPY ${w.spy >= 0 ? '+' : ''}${w.spy}%  ${w.winners.length} winners (${fromReport} on a report day)  ${w.winners.slice(0, 6).map(x => `${x.symbol} +${x.net}`).join(' · ')}`)
}
console.log('\nWHAT THEY SHARED — share of winners · share of every name · lift (winners ÷ all)')
for (const [trait, vals] of Object.entries(r.lift)) {
    console.log(`\n  ${trait}`)
    for (const [v, x] of Object.entries(vals)) console.log(`    ${v.padEnd(34)} ${String(x.winners).padStart(5)}% · ${String(x.all).padStart(5)}% · ${x.lift == null ? '—' : `${x.lift}x`}  (${x.n})`)
}
const all = r.weeks.flatMap(w => w.winners)
const onReport = all.filter(x => x.best_day_report)
console.log(`\nThe week's biggest day was a report day (or the day after) for ${onReport.length} of ${all.length} winners; their biggest day averaged +${(all.reduce((s, x) => s + x.best_day_move, 0) / (all.length || 1)).toFixed(1)}%.`)
