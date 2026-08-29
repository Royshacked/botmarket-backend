// Read helpers for the Aether DB collections.
// Node.js is read-only — Python writes these on a schedule via the compute repo.
// Every helper returns null when the collection is empty (engine not yet run).

import { getDb }     from '../../providers/mongodb.provider.js'
import { COLLECTIONS } from './aether.model.js'
import { logger }    from '../../services/logger.service.js'

const LOG = '[aetherService]'

/** Latest channel-state snapshot, or null. */
export async function getChannelState() {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTIONS.CHANNEL_STATE)
            .findOne({}, { sort: { computed_at: -1 }, projection: { _id: 0 } })
        return doc ?? null
    } catch (err) {
        logger.warn(LOG, 'getChannelState failed', err.message)
        return null
    }
}

/** Latest regime snapshot, or null. */
export async function getCurrentRegime() {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTIONS.REGIMES)
            .findOne({}, { sort: { computed_at: -1 }, projection: { _id: 0 } })
        return doc ?? null
    } catch (err) {
        logger.warn(LOG, 'getCurrentRegime failed', err.message)
        return null
    }
}

/** Active forecasts, sorted by resolution date ascending. */
export async function getForecasts() {
    try {
        const db   = await getDb()
        const docs = await db.collection(COLLECTIONS.FORECASTS)
            .find({ status: { $ne: 'resolved' } }, { sort: { resolution_date: 1 }, projection: { _id: 0 } })
            .toArray()
        return docs.length ? docs : null
    } catch (err) {
        logger.warn(LOG, 'getForecasts failed', err.message)
        return null
    }
}

/** Exposure record for one ticker, or null. */
export async function getExposure(ticker) {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTIONS.EXPOSURES)
            .findOne({ ticker: ticker.toUpperCase() }, { projection: { _id: 0 } })
        return doc ?? null
    } catch (err) {
        logger.warn(LOG, 'getExposure failed', err.message)
        return null
    }
}
