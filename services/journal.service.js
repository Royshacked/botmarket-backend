// The monitor journal — one row per model read, plus the code-written events on a trade (the fill,
// the close, an invalidation). Its own collection, keyed by entity (docs/design/talos-per-candle.md).
//
// It used to be `monitor_state.timeline[]` on the entity, capped at fifty. Two things ended that:
// Talos now reads on every candle close, so a 15-minute setup writes ~26 rows a day and a cap
// would wipe its history every two days; and the timeline rode on the envelope every list fetch
// carries, so every row cost every screen. Here it is uncapped, indexed newest-first, and read only
// by the pop-out that shows it.
//
// ONE writer for every caller — the monitor's wake write (dueLoop.makePersist), the reconciler's
// close line (entityRepo.finalizeClose) — so the shape and the collection are named in one place.

import { getDb } from '../providers/mongodb.provider.js'
import { logger } from './logger.service.js'

export const COLLECTION = 'journal'
const LOG = '[journal]'

/** Most rows one page may return. The pop-out asks for fifty and pages with `before`. */
const MAX_LIMIT = 200

export async function ensureJournalIndexes() {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).createIndex({ entityId: 1, at: -1 })
    } catch (err) {
        logger.warn(LOG, 'ensureJournalIndexes failed:', err.message)
    }
}

/**
 * Append one row. `entry` is what `monitorJournal.journalEntry` built — it already carries `at`.
 * Never throws: a lost journal line must not fail the wake that produced it, whose own write has
 * already landed. `db` is an optional seam for tests, like makePersist's.
 */
export async function appendJournal(entityId, entry, db = null) {
    if (!entityId || !entry) return
    try {
        const conn = db ?? await getDb()
        await conn.collection(COLLECTION).insertOne({ entityId, ...entry })
    } catch (err) {
        logger.error(LOG, `append failed for ${entityId}:`, err.message)
    }
}

/**
 * Newest first. `before` is the `at` of the oldest row the caller already has — the cursor for the
 * next page.
 * @returns {Promise<object[]>} rows without `_id`
 */
export async function listJournal(entityId, { before = null, limit = 50 } = {}, db = null) {
    if (!entityId) return []
    const conn = db ?? await getDb()
    const n = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT)
    const filter = { entityId, ...(before ? { at: { $lt: String(before) } } : {}) }
    return conn.collection(COLLECTION)
        .find(filter, { projection: { _id: 0 } })
        .sort({ at: -1 })
        .limit(n)
        .toArray()
}

export const journalService = { append: appendJournal, list: listJournal, ensureIndexes: ensureJournalIndexes }
