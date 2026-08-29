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

/**
 * Calibration status from aether_brier_scores, or null when no forecasts resolved yet.
 * Returns docs sorted by mean_brier ascending (best-calibrated first).
 */
export async function getCalibration() {
    try {
        const db   = await getDb()
        const docs = await db.collection(COLLECTIONS.BRIER_SCORES)
            .find({}, { sort: { mean_brier: 1 }, projection: { _id: 0 } })
            .toArray()
        return docs.length ? docs : null
    } catch (err) {
        logger.warn(LOG, 'getCalibration failed', err.message)
        return null
    }
}

/**
 * Full channel taxonomy from aether_taxonomy, or null when not yet synced.
 * Returns an array of channel docs sorted by clock (fast → medium → slow).
 */
export async function getTaxonomy() {
    try {
        const db   = await getDb()
        const docs = await db.collection(COLLECTIONS.TAXONOMY)
            .find({}, { projection: { _id: 0 } })
            .toArray()
        if (!docs.length) return null
        const clockOrder = { fast: 0, medium: 1, slow: 2 }
        docs.sort((a, b) => (clockOrder[a.clock] ?? 9) - (clockOrder[b.clock] ?? 9))
        return docs
    } catch (err) {
        logger.warn(LOG, 'getTaxonomy failed', err.message)
        return null
    }
}

// ── Phase 7 readers ───────────────────────────────────────────────────────────

/**
 * Latest portfolio slots from the most recent run_portfolio.py execution.
 * Fetches the newest computed_at, then returns all slots from that run
 * sorted by weight descending. Returns null when Phase 7 has not run.
 */
export async function getPortfolioSlots() {
    try {
        const db = await getDb()
        const sentinel = await db.collection(COLLECTIONS.PORTFOLIO_SLOTS)
            .findOne({}, { sort: { computed_at: -1 }, projection: { computed_at: 1 } })
        if (!sentinel) return null
        const docs = await db.collection(COLLECTIONS.PORTFOLIO_SLOTS)
            .find({ computed_at: sentinel.computed_at }, { sort: { weight: -1 }, projection: { _id: 0 } })
            .toArray()
        return docs.length ? docs : null
    } catch (err) {
        logger.warn(LOG, 'getPortfolioSlots failed', err.message)
        return null
    }
}

/**
 * Latest interference records from the most recent run_portfolio.py execution.
 * Returns null when Phase 7 has not run or no interactions were detected.
 */
export async function getInterference() {
    try {
        const db = await getDb()
        const sentinel = await db.collection(COLLECTIONS.INTERFERENCE)
            .findOne({}, { sort: { computed_at: -1 }, projection: { computed_at: 1 } })
        if (!sentinel) return null
        const docs = await db.collection(COLLECTIONS.INTERFERENCE)
            .find({ computed_at: sentinel.computed_at }, { sort: { severity: -1 }, projection: { _id: 0 } })
            .toArray()
        return docs.length ? docs : null
    } catch (err) {
        logger.warn(LOG, 'getInterference failed', err.message)
        return null
    }
}

/**
 * Most recently computed Monte Carlo loss surface, or null.
 */
export async function getLossSurface() {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTIONS.LOSS_SURFACE)
            .findOne({}, { sort: { computed_at: -1 }, projection: { _id: 0 } })
        return doc ?? null
    } catch (err) {
        logger.warn(LOG, 'getLossSurface failed', err.message)
        return null
    }
}

// ─────────────────────────────────────────────────────────────────────────────

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
