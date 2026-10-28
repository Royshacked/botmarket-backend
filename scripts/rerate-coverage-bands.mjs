// Re-rate every live coverage by the house's rating bands (services/ratingBands.js, coverage.service rerateCoverage) —
// once, after the bands ship (Roy, 2026-10-28: a name kept its old rating until its next re-model). Its own target, the
// price now, its horizon → the band's rating, with a revision that says why. The target and the thesis are untouched,
// and it is not a call: the scorecard does not log it.
//
//   node scripts/rerate-coverage-bands.mjs            DRY: every change listed, nothing written
//   node scripts/rerate-coverage-bands.mjs --write    writes them                 (the DB in .env — DB_NAME)
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const write = process.argv.includes('--write')
const { getDb } = await import('../providers/mongodb.provider.js')
const { COLLECTION, coverageService } = await import('../api/analyst/coverage.service.js')

// One price a name, from the shared FMP key the live app uses — paced, never a burst.
const PACE_MS = 300
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const db = await getDb()
const live = await db.collection(COLLECTION).find({ status: { $in: ['active', 'target_hit', 'thesis_broken'] } }, { projection: { _id: 0, id: 1, symbol: 1 } }).toArray()
console.log(`${process.env.DB_NAME ?? '(db)'}: ${live.length} live coverage · ${write ? 'WRITING' : 'dry run — nothing written'}`)
const tally = {}, moves = {}
for (const { id } of live.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    const r = await coverageService.rerateCoverage(id, { dry: !write })
    const k = r.ok ? r.outcome : `error ${r.reason ?? r.error?.message ?? ''}`
    tally[k] = (tally[k] ?? 0) + 1
    if (r.outcome === 'rerated') {
        const m = `${r.from ?? '—'} → ${r.to}`
        moves[m] = (moves[m] ?? 0) + 1
        console.log(`  ${r.symbol.padEnd(6)} ${m.padEnd(26)} target ${r.band.implied_pct > 0 ? '+' : ''}${r.band.implied_pct}% vs SPY ~+${r.band.market_pct}% over ${r.band.horizon}`)
    }
    await sleep(PACE_MS)
}
console.log('\n' + Object.entries(moves).sort((a, b) => b[1] - a[1]).map(([m, n]) => `  ${m}: ${n}`).join('\n'))
console.log(Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(' · ') + (write ? '' : '\nDry run. Run again with --write to apply.'))
process.exit(0)
