// P2 data migration: turn the legacy `ideas` collection into the kind-blind `entities` store.
// Idempotent and reversible-ish (a rename, not a drop). Run ONCE before deploying the P2b cutover:
//
//   node scripts/migrate-ideas-to-entities.mjs
//
// What it does:
//   1. Backfills `kind` (portfolioId != null ? 'portfolio_item' : 'idea') + `parentId` on every doc
//      that lacks a `kind` — so it never clobbers call/other kinds added later.
//   2. COPIES `ideas` → `entities` (idempotent upsert by id). `ideas` is LEFT INTACT as a backup —
//      drop it manually once the P2b cutover is verified. (A rename would be cleaner but the app's
//      Mongo client runs Stable API v1 strict, which disallows renameCollection.)
//   3. Ensures the entity indexes.
//
// Shape is UNCHANGED (flat + two new fields) — see ENTITY_MODEL.md P2 (decision: flat + kind).

import 'dotenv/config'   // standalone script — load .env (MONGODB_URI) itself
import { getDb } from '../providers/mongodb.provider.js'
import { logger } from '../services/logger.service.js'
import { ENTITIES } from '../services/entity/entityCollection.js'

const LOG = '[migrate:entities]'

// Pipeline update: parentId = portfolioId ?? null; kind from that. Only touches kind-less docs.
const STAMP_PIPELINE = [
    { $set: { parentId: { $ifNull: ['$portfolioId', null] } } },
    { $set: { kind: { $cond: [{ $eq: ['$parentId', null] }, 'idea', 'portfolio_item'] } } },
]

async function ensureIndexes(coll) {
    await coll.createIndex({ id: 1 }, { unique: true })
    await coll.createIndex({ userId: 1 })
    await coll.createIndex({ status: 1 })
    await coll.createIndex({ kind: 1 })
    await coll.createIndex({ parentId: 1 })
    await coll.createIndex({ orderState: 1 })
}

async function run() {
    const db    = await getDb()
    const names = (await db.listCollections().toArray()).map(c => c.name)
    const hasIdeas = names.includes('ideas')

    await ensureIndexes(db.collection(ENTITIES))

    if (!hasIdeas) {
        const n = await db.collection(ENTITIES).countDocuments()
        logger.info(LOG, `No \`ideas\` collection — assuming already migrated. \`${ENTITIES}\` holds ${n}.`)
        return
    }

    // 1. Backfill kind/parentId on the legacy source (idempotent — only kind-less docs).
    const stamp = await db.collection('ideas').updateMany({ kind: { $exists: false } }, STAMP_PIPELINE)
    logger.info(LOG, `Stamped kind/parentId on ${stamp.modifiedCount} legacy doc(s)`)

    // 2. Copy → entities, idempotent upsert by id (v1-safe; leaves `ideas` intact as backup).
    const docs = await db.collection('ideas').find({}).toArray()
    if (docs.length) {
        const ops = docs.map(d => ({ replaceOne: { filter: { id: d.id }, replacement: d, upsert: true } }))
        const res = await db.collection(ENTITIES).bulkWrite(ops, { ordered: false })
        logger.info(LOG, `Copied ${docs.length} doc(s) → \`${ENTITIES}\` (upserted ${res.upsertedCount}, replaced ${res.matchedCount})`)
    }

    const total = await db.collection(ENTITIES).countDocuments()
    logger.info(LOG, `Done. \`${ENTITIES}\` holds ${total} entit(y/ies). \`ideas\` kept as backup — drop after verifying P2b.`)
}

run()
    .then(() => process.exit(0))
    .catch(err => { logger.error(LOG, 'Migration failed:', err); process.exit(1) })
