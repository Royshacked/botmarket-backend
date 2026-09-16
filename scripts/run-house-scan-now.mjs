/**
 * One-off: run the Argus house scan against the view ALREADY in force.
 *
 * The scan normally fires from the publish route, so a view published before that wiring existed
 * never got one. This replays it — same code path (runHouseScan), no re-publish, no supersede, no
 * cards. WRITES to research_queue; enqueue is idempotent, so running it twice is safe.
 *
 * Usage:  node scripts/run-house-scan-now.mjs [--dry]
 */
import { getDb, closeDb }  from '../providers/mongodb.provider.js'
import { COLLECTION as TILT } from '../api/strategy/tilt.service.js'
import { COLLECTION as QUEUE } from '../services/researchQueue.service.js'
import { runHouseScan, overweightRows, hitsForConviction } from '../services/houseScan.service.js'

const dry = process.argv.includes('--dry')
const db  = await getDb()

const tilt = await db.collection(TILT).findOne({ status: 'active' }, { sort: { created_at: -1 } })
if (!tilt) { console.log('No active view — nothing to scan.'); await closeDb(); process.exit(0) }

const rows = overweightRows(tilt)
console.log(`View ${tilt.id} — regime: ${tilt.regime?.name ?? '-'}`)
if (!rows.length) {
    console.log('No overweight sector in this view. The scan would no-op; publish a view with an `over` stance.')
    await closeDb(); process.exit(0)
}
for (const r of rows) console.log(`  ${r.sector.padEnd(22)} ${String(r.active_bp ?? '-').padStart(5)}bp  basis=${r.basis ?? '-'}  → ${hitsForConviction(r.active_bp)} names`)

if (dry) { console.log('\n--dry: stopping before the screen.'); await closeDb(); process.exit(0) }

const before = await db.collection(QUEUE).countDocuments({})
await runHouseScan(tilt)
const after = await db.collection(QUEUE).countDocuments({})
console.log(`\nqueue: ${before} → ${after}  (+${after - before})`)

await closeDb()
