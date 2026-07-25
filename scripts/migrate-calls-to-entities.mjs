// P3a data migration: move Kairos calls into the shared `entities` collection as kind:'call'.
// Idempotent; leaves `kairos_calls` intact as a backup. Run BEFORE deploying the P3a cutover:
//
//   node scripts/migrate-calls-to-entities.mjs
//
// Calls keep their native (snake_case) shape — P3a is behavior-preserving (a collection move, like
// P2). Only `kind:'call'` + `parentId:null` are added. The idea-shadow execution mechanism is
// UNCHANGED. See ENTITY_MODEL.md P3.

import 'dotenv/config'
import { getDb } from '../providers/mongodb.provider.js'
import { logger } from '../services/logger.service.js'
import { ENTITIES } from '../services/entity/entityCollection.js'

const LOG = '[migrate:calls]'
const SOURCE = 'kairos_calls'

async function run() {
    const db    = await getDb()
    const names = (await db.listCollections().toArray()).map(c => c.name)

    // Calls query by user_id (snake) — ensure that index exists on entities alongside the idea ones.
    await db.collection(ENTITIES).createIndex({ user_id: 1 })

    if (!names.includes(SOURCE)) {
        const n = await db.collection(ENTITIES).countDocuments({ kind: 'call' })
        logger.info(LOG, `No \`${SOURCE}\` collection — assuming already migrated. entities holds ${n} call(s).`)
        return
    }

    // 1. Stamp kind/parentId on kind-less call docs (idempotent).
    const stamp = await db.collection(SOURCE).updateMany(
        { kind: { $exists: false } },
        { $set: { kind: 'call', parentId: null } },
    )
    logger.info(LOG, `Stamped kind:'call'/parentId on ${stamp.modifiedCount} call(s)`)

    // 2. Copy → entities, idempotent upsert by id (leaves kairos_calls as backup).
    const docs = await db.collection(SOURCE).find({}).toArray()
    if (docs.length) {
        const ops = docs.map(d => ({ replaceOne: { filter: { id: d.id }, replacement: d, upsert: true } }))
        const res = await db.collection(ENTITIES).bulkWrite(ops, { ordered: false })
        logger.info(LOG, `Copied ${docs.length} call(s) → \`${ENTITIES}\` (upserted ${res.upsertedCount}, replaced ${res.matchedCount})`)
    }

    const total = await db.collection(ENTITIES).countDocuments({ kind: 'call' })
    logger.info(LOG, `Done. \`${ENTITIES}\` holds ${total} call(s). \`${SOURCE}\` kept as backup.`)
}

run()
    .then(() => process.exit(0))
    .catch(err => { logger.error(LOG, 'Migration failed:', err); process.exit(1) })
