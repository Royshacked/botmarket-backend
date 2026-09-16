// A two-layer cache: an in-process TTL map over a Mongo collection, for facts that barely move and
// are expensive to ask for again — FMP fundamentals (quarterly), Finnhub company profiles (static).
//
// The memory layer is the fast path. The Mongo layer is what survives a restart: a nodemon reload
// or a deploy on a busy earnings day used to re-burn the whole daily quota re-fetching what the
// process had known a minute earlier. Both providers had written this pair of functions out by
// hand, identically but for the collection and the field names; this is that pair, once.
//
// Mongo is BEST-EFFORT on both sides. A read that fails is a miss (the provider is asked), a write
// that fails is logged and the memory layer still has the value. The cache must never turn a
// provider outage into a database dependency, or a database outage into a provider outage.
//
// Document shape: `{ [keyField]: key, ...value, fetchedAt }`. The value is spread rather than
// nested so the two collections that already exist keep reading — nothing to migrate.

import { getDb as _defaultGetDb } from '../providers/mongodb.provider.js'
import { createTtlCache } from './ttlCache.util.js'
import { logger } from './logger.service.js'

/**
 * @param {{ collection: string, ttlMs: number, max?: number, log?: string, keyField?: string,
 *           getDb?: () => Promise<import('mongodb').Db> }} cfg   `getDb` is injectable so the shape of
 *           both layers is testable against a fake collection.
 */
export function makeMongoBackedCache({ collection, ttlMs, max = 500, log = '[mongoCache]', keyField = 'symbol', getDb = _defaultGetDb }) {
    if (!collection) throw new Error('makeMongoBackedCache: collection is required')
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('makeMongoBackedCache: ttlMs is required')
    const mem = createTtlCache({ ttlMs, max })

    return {
        /** The cached value, or null. Memory first, then a Mongo document younger than the TTL. */
        async read(key) {
            const hit = mem.get(key)
            if (hit) return hit
            try {
                const db  = await getDb()
                const doc = await db.collection(collection).findOne({ [keyField]: key })
                if (doc && Date.now() - doc.fetchedAt < ttlMs) {
                    const { _id, fetchedAt, [keyField]: _k, ...value } = doc   // eslint-disable-line no-unused-vars
                    mem.set(key, value)
                    return value
                }
            } catch (err) {
                logger.warn(log, 'Mongo cache read failed', err.message)
            }
            return null
        },

        /** Store a value in both layers. The memory layer is set FIRST, so a failed Mongo write costs persistence, not the answer. */
        async write(key, value) {
            mem.set(key, value)
            try {
                const db = await getDb()
                await db.collection(collection).updateOne(
                    { [keyField]: key },
                    { $set: { [keyField]: key, ...value, fetchedAt: Date.now() } },
                    { upsert: true },
                )
            } catch (err) {
                logger.warn(log, 'Mongo cache write failed', err.message)
            }
        },
    }
}
