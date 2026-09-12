/**
 * Diagnostic: why is the research queue empty?
 *
 * Reads the three facts that decide it — the view in force, whether it carries an overweight
 * sector at all, and what is actually in the queue. Read-only.
 *
 * Usage:  node scripts/check-house-pipeline.mjs
 */
import 'dotenv/config'
import { getDb, closeDb } from '../providers/mongodb.provider.js'
import { COLLECTION as TILT }  from '../api/strategy/tilt.service.js'
import { COLLECTION as QUEUE } from '../services/researchQueue.service.js'

const db = await getDb()

const tilt = await db.collection(TILT).findOne({ status: 'active' }, { sort: { created_at: -1 } })
if (!tilt) {
    console.log('TILT: no active view — nothing could ever have triggered a scan')
} else {
    const over = (tilt.tilts ?? []).filter(r => r?.stance === 'over').map(r => `${r.sector} +${r.active_bp}bp`)
    console.log(`TILT: ${tilt.id}`)
    console.log(`  published : ${tilt.created_at}`)
    console.log(`  regime    : ${tilt.regime?.name ?? '-'}`)
    console.log(`  stances   : ${(tilt.tilts ?? []).map(r => `${r.sector}=${r.stance}`).join(', ') || '(none)'}`)
    console.log(`  OVERWEIGHT: ${over.length ? over.join(', ') : '(none — the house scan would no-op)'}`)
    console.log(`  revisions : ${(tilt.revisions ?? []).map(r => `${r.kind}@${String(r.at).slice(0, 10)}`).join(' → ') || '(none)'}`)
}

const byStatus = await db.collection(QUEUE).aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray()
console.log(`\nQUEUE (${QUEUE}): ${byStatus.length ? byStatus.map(r => `${r._id}=${r.n}`).join(', ') : 'EMPTY — zero documents'}`)

const recent = await db.collection(QUEUE).find({}).sort({ created_at: -1 }).limit(10).toArray()
for (const r of recent) console.log(`  ${r.symbol.padEnd(6)} ${r.status.padEnd(12)} ${r.source}/${r.requestedBy}  ${r.created_at}`)

await closeDb()
