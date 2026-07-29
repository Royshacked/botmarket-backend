// Converge the `setup` kind back onto the ONE shared status ladder. Idempotent; run BEFORE deploying:
//
//   node scripts/migrate-setup-statuses.mjs
//
//   old         new         meaning
//   ─────────── ─────────── ────────────────────────────────────────────────────────
//   unarmed  →  waiting     persisted, NOT monitored (Arm is the user's separate act)
//   waiting  →  looking     armed
//   watching →  looking     price inside a zone is `armed_zone_id`, not a lifecycle rung
//   ready    →  hit         entry fired, awaiting the user's confirm
//
// WHY. Setups briefly ran a private vocabulary, and every synonym broke something: `unarmed`/`ready`
// left the confirm dialog gating on a status nothing wrote, and `watching` left the Setups hub
// counting `looking` and therefore always showing zero. One word per meaning, across every kind, is
// the invariant now — services/entity/vocabulary.js is the source of truth and tests pin it.
//
// ORDER IS LOAD-BEARING, and in the opposite direction to the migration this replaces. `waiting` is
// both a source and a target: renaming waiting→looking BEFORE unarmed→waiting would sweep the
// just-renamed unarmed setups straight on to `looking` and silently ARM every setup the user had
// deliberately left unarmed. Hence unarmed first, plus the explicit guard below.
//
// `ready` → `hit` is unconditional: they are the same rung, and `ordersPlacedAt` — not the status —
// is what says an order reached the broker, so nothing can be double-placed by this rename.

import 'dotenv/config'
import { getDb } from '../providers/mongodb.provider.js'
import { logger } from '../services/logger.service.js'
import { ENTITIES } from '../services/entity/entityCollection.js'
import { statusesFor } from '../services/entity/vocabulary.js'

const LOG = '[migrate:setup-statuses]'

async function run() {
    const db   = await getDb()
    const coll = db.collection(ENTITIES)

    const before = await coll.countDocuments({ kind: 'setup' })
    if (before === 0) {
        logger.info(LOG, 'No setups — nothing to migrate.')
        return
    }

    // Surface the ordering hazard rather than trusting the sequence below to stay put.
    const unarmedN = await coll.countDocuments({ kind: 'setup', status: 'unarmed' })
    const waitingN = await coll.countDocuments({ kind: 'setup', status: 'waiting' })
    if (unarmedN && waitingN) {
        logger.info(LOG, `${unarmedN} unarmed + ${waitingN} waiting — renaming unarmed FIRST so no setup is silently armed`)
    }

    const steps = [
        ['unarmed',  'waiting'],   // MUST run before waiting → looking
        ['waiting',  'looking'],
        ['watching', 'looking'],   // the in-zone fact already lives on armed_zone_id
        ['ready',    'hit'],
    ]
    for (const [from, to] of steps) {
        const res = await coll.updateMany({ kind: 'setup', status: from }, { $set: { status: to } })
        if (res.modifiedCount) logger.info(LOG, `${from} → ${to}: ${res.modifiedCount}`)
    }

    const allowed = statusesFor('setup')
    const stray = await coll.find(
        { kind: 'setup', status: { $nin: allowed } },
        { projection: { id: 1, status: 1 } },
    ).toArray()
    if (stray.length) {
        logger.warn(LOG, `${stray.length} setup(s) on a status outside the vocabulary — investigate: ` +
            stray.map(s => `${s.id}=${s.status}`).join(' '))
    }

    const counts = await coll.aggregate([
        { $match: { kind: 'setup' } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
        { $sort: { _id: 1 } },
    ]).toArray()
    logger.info(LOG, `Done. ${before} setup(s): ${counts.map(c => `${c._id}=${c.n}`).join(' ')}`)
}

run()
    .then(() => process.exit(0))
    .catch(err => { logger.error(LOG, 'Migration failed:', err); process.exit(1) })
