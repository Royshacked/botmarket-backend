// Seed Prometheus's scorecard from the coverage he wrote before it (services/prometheusCalls.backfill.js) — every call in
// each document's revision trail, logged `source: 'backfill'`. Safe to re-run: a call already logged is skipped.
// Then grades what is due (the scorecard loop does the same every 6 hours).
//
//   node scripts/backfill-prometheus-calls.mjs [--dry]      (the DB in .env — DB_NAME)
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const dry = process.argv.includes('--dry')
const { getDb } = await import('../providers/mongodb.provider.js')
const { COLLECTION } = await import('../api/analyst/coverage.service.js')
const { prometheusCallsService } = await import('../services/prometheusCalls.service.js')
const { callsFromTrail } = await import('../services/prometheusCalls.backfill.js')

const db = await getDb()
const docs = await db.collection(COLLECTION).find({}).toArray()
// The seed stops where the forward record starts: a call the live hook already logged (run after the deploy) is not
// logged twice under the other source. Per coverage, its first forward call; none → now.
const firstForward = new Map((await db.collection('prometheus_calls').aggregate([{ $match: { source: 'forward' } }, { $group: { _id: '$coverage_id', at: { $min: '$made_at' } } }]).toArray()).map(r => [r._id, r.at]))
const cutoff = new Date().toISOString()
let calls = 0, logged = 0, skipped = 0
for (const cov of docs) {
    for (const c of callsFromTrail(cov)) {
        if (c.at >= (firstForward.get(cov.id) ?? cutoff)) { skipped++; continue }
        calls++
        if (dry) { console.log(`  ${c.at.slice(0, 10)} ${cov.symbol.padEnd(6)} ${c.state.rating ?? '-'} PT ${c.state.price_target?.value ?? '-'} ${c.state.price_target?.horizon ?? ''}`); continue }
        if (await prometheusCallsService.recordCoverageCall(c.state, { prev: c.prev, source: 'backfill', at: c.at })) logged++
    }
}
console.log(`${docs.length} coverage documents · ${calls} calls in their trails${dry ? ' (dry run)' : ` · ${logged} newly logged`}${skipped ? ` · ${skipped} left to the forward record` : ''}`)
if (!dry) console.log('graded:', await prometheusCallsService.gradeDue())
process.exit(0)
