// P2 data migration: turn the legacy `ideas` collection into the kind-blind `entities` store.
// Idempotent and reversible-ish (a rename, not a drop). Run ONCE before deploying the P2b cutover:
//
//   node scripts/migrate-ideas-to-entities.mjs
//
// What it does:
//   1. Backfills `kind` (portfolioId != null ? 'portfolio_item' : 'idea') + `parentId` on every doc
//      that lacks a `kind` — so it never clobbers call/other kinds added later.
//   2. Renames `ideas` → `entities` (skipped if `entities` already exists).
//   3. Ensures the entity indexes.
//
// Shape is UNCHANGED (flat + two new fields) — see ENTITY_MODEL.md P2 (decision: flat + kind).

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
    const hasEntities = names.includes(ENTITIES)
    const hasIdeas    = names.includes('ideas')

    // The collection we stamp: entities if it already exists, else the legacy ideas.
    const source = hasEntities ? ENTITIES : (hasIdeas ? 'ideas' : null)
    if (!source) {
        logger.warn(LOG, 'Neither `ideas` nor `entities` exists — nothing to migrate.')
        return
    }

    const stamp = await db.collection(source).updateMany({ kind: { $exists: false } }, STAMP_PIPELINE)
    logger.info(LOG, `Stamped kind/parentId on ${stamp.modifiedCount} doc(s) in \`${source}\``)

    if (!hasEntities && hasIdeas) {
        await db.collection('ideas').rename(ENTITIES)
        logger.info(LOG, `Renamed \`ideas\` → \`${ENTITIES}\``)
    } else if (hasEntities) {
        logger.info(LOG, `\`${ENTITIES}\` already exists — skipped rename (idempotent re-run).`)
    }

    await ensureIndexes(db.collection(ENTITIES))
    const total = await db.collection(ENTITIES).countDocuments()
    logger.info(LOG, `Done. \`${ENTITIES}\` holds ${total} entit(y/ies).`)
}

run()
    .then(() => process.exit(0))
    .catch(err => { logger.error(LOG, 'Migration failed:', err); process.exit(1) })
