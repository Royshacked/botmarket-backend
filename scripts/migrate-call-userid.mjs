// Converge the call kind's owner field onto the envelope name: `user_id` → `userId`.
// Idempotent; run BEFORE deploying the cutover:
//
//   node scripts/migrate-call-userid.mjs
//
// WHY. Calls were moved into the shared `entities` collection by migrate-calls-to-entities.mjs
// keeping their native snake_case shape — including `user_id`. Ideas and setups in that SAME
// collection store `userId`, which is also what the envelope declares (envelope.js Envelope.userId).
// The two names co-existing broke every kind-blind reader that filters by owner: notably
// tradeIdeas.getCallPositionMap ({ userId, kind:'call' }) could never match a call, so a
// call-originated position had no resolvable owner on the Positions tab.
//
// Owner is an ENVELOPE field, not payload — so it converges. The call payload's other snake_case
// fields (asset_class, main_account_id, broker_symbol, …) are untouched by design.
//
// The `kairos_calls` backup collection is left alone; it is a snapshot of the pre-move shape.

import 'dotenv/config'
import { getDb } from '../providers/mongodb.provider.js'
import { logger } from '../services/logger.service.js'
import { ENTITIES } from '../services/entity/entityCollection.js'

const LOG = '[migrate:call-userid]'

async function run() {
    const db = await getDb()
    const coll = db.collection(ENTITIES)

    // Guard: a doc carrying BOTH names is ambiguous ($rename would clobber userId). None should
    // exist — nothing ever wrote userId onto a call — but refuse rather than silently pick one.
    const conflicts = await coll.countDocuments({
        kind: 'call', user_id: { $exists: true }, userId: { $exists: true },
    })
    if (conflicts > 0) {
        throw new Error(`${conflicts} call(s) carry BOTH user_id and userId — resolve by hand before migrating`)
    }

    const pending = await coll.countDocuments({ kind: 'call', user_id: { $exists: true } })
    if (pending === 0) {
        const total = await coll.countDocuments({ kind: 'call' })
        logger.info(LOG, `Nothing to rename — already migrated. entities holds ${total} call(s).`)
    } else {
        const res = await coll.updateMany(
            { kind: 'call', user_id: { $exists: true } },
            { $rename: { user_id: 'userId' } },
        )
        logger.info(LOG, `Renamed user_id → userId on ${res.modifiedCount}/${pending} call(s)`)
    }

    // Ideas already index { userId: 1 }; make sure it exists, then retire the call-only index.
    await coll.createIndex({ userId: 1 })
    try {
        await coll.dropIndex('user_id_1')
        logger.info(LOG, 'Dropped the now-unused user_id_1 index')
    } catch {
        logger.info(LOG, 'No user_id_1 index to drop')
    }

    const orphans = await coll.countDocuments({ kind: 'call', userId: { $exists: false } })
    if (orphans > 0) logger.warn(LOG, `${orphans} call(s) have NO owner field at all — these were already ownerless`)
    logger.info(LOG, 'Done.')
}

run()
    .then(() => process.exit(0))
    .catch(err => { logger.error(LOG, 'Migration failed:', err); process.exit(1) })
