// THE WEEK AFTER A BIG WEEK (services/moverDiff.service.js followThrough) — the names 5%+ over SPY in a week, and how
// they went AFTER it, against every name (Roy, 2026-10-25).
//
//   node scripts/lab-follow.mjs [weeks=52] [min=5] [--holds=5,10,15,21]
//
// Without --holds: the next calendar week. With it: held that many sessions from the next Monday's open — one table,
// a column per hold (the range over non-overlapping blocks of weeks as long as the hold).
// Offline on the one-year cache (data/lab/screener.json + its earnings history).
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const args = process.argv.slice(2)
const [weeks = 52, min = 5] = args.filter(a => !a.startsWith('--')).map(Number)
const holds = args.find(a => a.startsWith('--holds='))?.split('=')[1].split(',').map(Number) ?? [null]
const { followThrough } = await import('../services/moverDiff.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { closeDb } = await import('../providers/mongodb.provider.js')
const data = await loadLabData({ name: 'screener', extras: ['history'] })
await closeDb()
const runs = holds.map(hold => ({ hold, r: followThrough(data, { weeks, min, hold }) }))
const s = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x}`)
console.log(`${runs[0].r.weeks} weeks · AFTER the week, net vs SPY from the next Monday's open, after the cost — per week (each week once) [95%] · up-share\n`)
console.log(`  ${'last week'.padEnd(40)}${runs.map(({ hold }) => (hold ? `held ${hold}` : 'next week').padEnd(30)).join('')}`)
for (const g of Object.keys(runs[0].r.groups)) {
    const cells = runs.map(({ r }) => {
        const v = r.groups[g]
        return (v.n ? `${s(v.next_week_mean)} [${v.ci95?.map(s).join('…') ?? '—'}] ${v.next_up}%` : 'none').padEnd(30)
    })
    console.log(`  ${g.padEnd(40)}${cells.join('')}  (${runs[0].r.groups[g].n ?? 0})`)
}
