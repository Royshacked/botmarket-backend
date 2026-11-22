// Backfill `price_target.ref_price` — the price a live target was set at (coverage.service withTargetRef, 2026-11-21) —
// on targets saved before it (2026-11-22). coverage.assess.targetWay reads it for which way a target points: without it
// a target falls back to its rating's direction, and a hold never registers a hit. The price is the entry close of the
// scorecard call that froze that same target (prometheusCalls refPriceFromCalls). No revision: it is a fact about the
// target, not a change of the call. A target with no entered call is left as it is.
//
//   node scripts/backfill-coverage-ref-price.mjs            DRY: every fill listed, nothing written
//   node scripts/backfill-coverage-ref-price.mjs --write    writes them                 (the DB in .env — DB_NAME)
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const write = process.argv.includes('--write')
const { getDb } = await import('../providers/mongodb.provider.js')
const { COLLECTION } = await import('../api/analyst/coverage.service.js')
const { COLLECTION: CALLS, refPriceFromCalls } = await import('../services/prometheusCalls.service.js')

const db = await getDb()
const live = await db.collection(COLLECTION).find(
    { status: { $in: ['active', 'target_hit', 'thesis_broken'] }, 'price_target.value': { $ne: null }, 'price_target.ref_price': { $exists: false } },
    { projection: { _id: 0, id: 1, symbol: 1, price_target: 1 } },
).toArray()
const calls = await db.collection(CALLS).find(
    { symbol: { $in: live.map(c => c.symbol) } },
    { projection: { _id: 0, symbol: 1, coverage_id: 1, pt: 1, made_at: 1, entry: 1 } },
).toArray()
const bySymbol = Map.groupBy(calls, c => c.symbol)
console.log(`${process.env.DB_NAME ?? '(db)'}: ${live.length} live targets without a set-price · ${write ? 'WRITING' : 'dry run — nothing written'}`)

let filled = 0, none = 0
for (const cov of live.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    const ref = refPriceFromCalls(cov, bySymbol.get(cov.symbol))
    if (ref === null) { none++; console.log(`  ${cov.symbol.padEnd(6)} no entered call for target ${cov.price_target.value} — left`); continue }
    const r2 = Math.round(ref * 100) / 100
    console.log(`  ${cov.symbol.padEnd(6)} target ${cov.price_target.value} set at ${r2} → points ${cov.price_target.value > r2 ? 'up' : cov.price_target.value < r2 ? 'down' : 'flat'}`)
    if (write) await db.collection(COLLECTION).updateOne({ id: cov.id, 'price_target.ref_price': { $exists: false } }, { $set: { 'price_target.ref_price': r2 } })
    filled++
}
console.log(`\nfilled ${filled} · left ${none}` + (write ? '' : '\nDry run. Run again with --write to apply.'))
process.exit(0)
