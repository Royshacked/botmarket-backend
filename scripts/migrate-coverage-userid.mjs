// Converge the `coverage` collection's owner field onto `userId`, matching every other
// owner-scoped list. Idempotent; run BEFORE deploying the cutover:
//
//   node scripts/migrate-coverage-userid.mjs
//
// WHY. Coverage is the Analyst's research artifact — its own collection, not an execution-tier
// entity — but it is still an owner-scoped list, so it rides the shared entityCrud. One owner field
// name across every list is what lets that factory exist at all; `user_id` here was the last
// holdout (calls were converged by migrate-call-userid.mjs).
//
// The coverage PAYLOAD stays snake_case (created_at, price_target, kill_criteria …). Only the
// owner moves, for the same reason it moved on calls: it is identity, not payload.
//
// ORDER IS LOAD-BEARING. The old unique index is (user_id, symbol). Renaming with it still in
// place would, on the second user covering the same ticker, produce a duplicate (missing, symbol)
// key and abort updateMany PART-WAY THROUGH — a half-migrated collection. So: drop first, rename,
// then rebuild. The rebuild can only succeed because the rename is 1:1 on a previously-unique pair.

import 'dotenv/config'
import { getDb } from '../providers/mongodb.provider.js'
import { logger } from '../services/logger.service.js'

const LOG = '[migrate:coverage-userid]'
const COLLECTION = 'coverage'

const OLD_INDEXES = ['user_id_1_symbol_1', 'user_id_1_status_1']

async function run() {
    const db   = await getDb()
    const coll = db.collection(COLLECTION)

    if (!(await db.listCollections({ name: COLLECTION }).toArray()).length) {
        logger.info(LOG, `No \`${COLLECTION}\` collection — nothing to migrate.`)
        return
    }

    const conflicts = await coll.countDocuments({ user_id: { $exists: true }, userId: { $exists: true } })
    if (conflicts > 0) {
        throw new Error(`${conflicts} coverage doc(s) carry BOTH user_id and userId — resolve by hand before migrating`)
    }

    // 1. Drop the owner indexes BEFORE the rename (see the note above).
    for (const name of OLD_INDEXES) {
        try {
            await coll.dropIndex(name)
            logger.info(LOG, `Dropped ${name}`)
        } catch {
            logger.info(LOG, `No ${name} to drop`)
        }
    }

    // 2. Rename.
    const pending = await coll.countDocuments({ user_id: { $exists: true } })
    if (pending === 0) {
        logger.info(LOG, `Nothing to rename — already migrated (${await coll.countDocuments({})} doc(s)).`)
    } else {
        const res = await coll.updateMany({ user_id: { $exists: true } }, { $rename: { user_id: 'userId' } })
        logger.info(LOG, `Renamed user_id → userId on ${res.modifiedCount}/${pending} coverage doc(s)`)
    }

    // 3. Rebuild under the new name. Unique on (userId, symbol) is the race backstop the initiate
    // check relies on — if this throws, the collection has genuine duplicates and needs a look.
    await coll.createIndex({ id: 1 }, { unique: true })
    await coll.createIndex({ userId: 1, symbol: 1 }, { unique: true })
    await coll.createIndex({ userId: 1, status: 1 })
    logger.info(LOG, 'Rebuilt indexes on userId. Done.')
}

run()
    .then(() => process.exit(0))
    .catch(err => { logger.error(LOG, 'Migration failed:', err); process.exit(1) })
