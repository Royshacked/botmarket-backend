// Delete every `setup` entity — the migration for the leg-shape change (2026-09-24).
//
// WHY A DELETE AND NOT A CONVERSION. `entry_zones` / `stop_zones` / `tp_zones`, each `{lower,
// upper}`, became `entry_legs` / `stop_legs` / `target_legs`, each `{price}`
// (docs/desks/mentor-talos.md §Legs). Converting was possible — a band collapses to the edge the
// broker was already resting at — and the user's call was to start clean instead, with one
// consequence accepted knowingly: an OPEN position whose entity is deleted is orphaned. Its order
// and its resting stop stay at the broker, and nothing in the app watches them any more.
//
// WHAT IS NOT TOUCHED, and it is most of the book:
//   • `idea` and `portfolio_item` — a holding IS an idea document, and the `lower`/`upper` on one is
//     `invalidation.range`, a genuine range with anchors. Nothing to migrate and nothing to delete.
//   • `call` — Kairos is archived and its documents are frozen. They keep the band shape on purpose;
//     `callToWatchRow` and `deriveCallOverlay` are its last readers.
//   • `journal` rows and `talos_reads` bundles belonging to a deleted setup. They are an append-only
//     record of what happened, and a record of a trade that existed is not invalidated by the
//     document being gone.
//
// DRY RUN by default. Pass --apply to delete.
//
//   node scripts/wipe-setups.mjs                      # local DB_NAME
//   node scripts/wipe-setups.mjs --apply
//   DB_NAME=test node scripts/wipe-setups.mjs --apply # prod

import dns from 'node:dns'
import { getDb } from '../providers/mongodb.provider.js'
import { ENTITIES } from '../services/entity/entityCollection.js'
import { config } from '../services/config.js'
import { LIVE_POSITION } from '../services/entity/vocabulary.js'

// Mongo's SRV lookup fails on this laptop's default resolver (docs: the DNS pin every script here
// carries). Harmless where it already worked.
if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const apply = process.argv.includes('--apply')

const db = await getDb()
const coll = db.collection(ENTITIES)

const setups = await coll
    .find({ kind: 'setup' }, { projection: { id: 1, asset: 1, status: 1, userId: 1, brokerOrders: 1 } })
    .toArray()

console.log(`DB "${db.databaseName}" — ${setups.length} setup${setups.length === 1 ? '' : 's'}`)
for (const s of setups) {
    const live = LIVE_POSITION.includes(s.status)
    console.log(`  ${live ? '!!' : '  '} ${s.asset ?? '?'} · ${s.status ?? '?'} · ${s.id}${live ? '   ← OPEN POSITION: the broker order and its stop survive this, unwatched' : ''}`)
}

// Said once, loudly, whether or not --apply was passed: the dry run is where somebody decides.
const open = setups.filter(s => LIVE_POSITION.includes(s.status))
if (open.length) {
    console.log(`\n${open.length} of these ${open.length === 1 ? 'is' : 'are'} an OPEN POSITION. Deleting the entity does not close the trade —`)
    console.log('the position and its resting stop stay at the broker and must be managed by hand from there.')
}

if (!apply) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --apply.')
    process.exit(0)
}

const res = await coll.deleteMany({ kind: 'setup' })
console.log(`\nDeleted ${res.deletedCount}.`)
process.exit(0)
