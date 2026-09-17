// Move every entity's embedded `monitor_state.timeline[]` into the `journal` collection
// (docs/design/talos-per-candle.md, Phase 0). Idempotent; run once after deploying the journal
// service, before the pop-out is switched to the route:
//
//   node scripts/migrate-journal.mjs
//
// Each entry becomes one row `{ entityId, ...entry }`; the array is then unset. A wake reason that
// no longer exists is mapped onto the vocabulary the new journal speaks — the quiet wakes that used
// to write a line (`market_closed`, `guard_time`, `backstop`, `scheduled`, `closed`) are DROPPED,
// because under the new rule a wake that cost no model call writes nothing, and keeping them would
// make an old journal read like a different monitor's.
//
// Idempotent because the array is unset in the same pass: a re-run finds nothing to move.

import { getDb } from '../providers/mongodb.provider.js'
import { logger } from '../services/logger.service.js'
import { ENTITIES } from '../services/entity/entityCollection.js'
import { COLLECTION as JOURNAL, ensureJournalIndexes } from '../services/journal.service.js'

const LOG = '[migrate:journal]'

/** old reason → new; `null` drops the row. Reasons not listed pass through unchanged. */
const REASON = {
    zone_trip:      'candle',
    momentum_pulse: 'candle',
    in_position:    'candle',
    guard_price:    'guard',
    market_closed:  null,
    closed:         null,
    guard_time:     null,
    backstop:       null,
    scheduled:      null,
}

async function run() {
    const db   = await getDb()
    const ents = db.collection(ENTITIES)
    await ensureJournalIndexes()

    const cursor = ents.find({ 'monitor_state.timeline.0': { $exists: true } }, { projection: { id: 1, 'monitor_state.timeline': 1 } })
    let entities = 0, moved = 0, dropped = 0

    for await (const doc of cursor) {
        const rows = []
        for (const e of doc.monitor_state.timeline) {
            // Talos briefly wrote `{kind, next_at, read}` where the shared builder writes
            // `{reason, next_check_at, note}` — read both, write one.
            const reason = e?.reason ?? e?.kind ?? 'candle'
            const mapped = reason in REASON ? REASON[reason] : reason
            if (mapped == null) { dropped++; continue }
            const { kind, next_at, read, ...rest } = e
            rows.push({
                entityId: doc.id,
                ...rest,
                reason: mapped,
                ...(next_at != null && rest.next_check_at == null ? { next_check_at: next_at } : {}),
                ...(read != null && rest.note == null ? { note: read } : {}),
            })
        }
        if (rows.length) await db.collection(JOURNAL).insertMany(rows)
        await ents.updateOne({ id: doc.id }, { $unset: { 'monitor_state.timeline': '' } })
        entities++
        moved += rows.length
    }

    logger.info(LOG, `${entities} entities · ${moved} rows moved · ${dropped} quiet-wake lines dropped`)
}

run()
    .then(() => process.exit(0))
    .catch(err => { logger.error(LOG, err); process.exit(1) })
