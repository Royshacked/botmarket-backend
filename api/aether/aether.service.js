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
        // Python writes one summary doc keyed by _id:'latest_snapshot' — shaped for the component.
        const doc = await db.collection(COLLECTIONS.CHANNEL_STATE)
            .findOne({ _id: 'latest_snapshot' }, { projection: { _id: 0 } })
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

// ── Phase 8 readers ───────────────────────────────────────────────────────────

/**
 * All EdgeCandidate docs (any status) for budget computation + active pipeline view.
 * Returns null when governance has not yet run (no candidates submitted).
 */
export async function getAllCandidates() {
    try {
        const db   = await getDb()
        const docs = await db.collection(COLLECTIONS.EDGE_CANDIDATES)
            .find({}, { projection: { _id: 0 } })
            .toArray()
        return docs.length ? docs : null
    } catch (err) {
        logger.warn(LOG, 'getAllCandidates failed', err.message)
        return null
    }
}

/**
 * Latest decay audit batch from the most recent run_governance.py --decay-audit run.
 * Uses the two-query sentinel pattern: find newest audit_date, then fetch the full batch.
 * Returns null when no decay audit has run.
 */
export async function getDecayAudit() {
    try {
        const db = await getDb()
        const sentinel = await db.collection(COLLECTIONS.DECAY_AUDIT)
            .findOne({}, { sort: { audit_date: -1 }, projection: { audit_date: 1 } })
        if (!sentinel) return null
        const docs = await db.collection(COLLECTIONS.DECAY_AUDIT)
            .find({ audit_date: sentinel.audit_date }, { sort: { recommendation: 1, weight_ratio: 1 }, projection: { _id: 0 } })
            .toArray()
        return docs.length ? docs : null
    } catch (err) {
        logger.warn(LOG, 'getDecayAudit failed', err.message)
        return null
    }
}

// ── Mission 5 (shock pipeline) readers ───────────────────────────────────────

/**
 * Active provisional shock predictions from aether_predictions.
 * Returns up to `limit` docs sorted by confidence descending, then created_at descending.
 * Returns null when the shock pipeline has not produced any predictions yet.
 */
export async function getActiveShockPredictions(limit = 40) {
    try {
        const db   = await getDb()
        const docs = await db.collection(COLLECTIONS.PREDICTIONS)
            .find(
                { status: 'provisional' },
                { sort: { confidence_llm: -1, created_at: -1 }, projection: { _id: 0 }, limit },
            )
            .toArray()
        return docs.length ? docs : null
    } catch (err) {
        logger.warn(LOG, 'getActiveShockPredictions failed', err.message)
        return null
    }
}

/**
 * Recent confirmed/rejected validation outcomes from the FRED validation loop.
 * Returns up to `limit` docs sorted by validated_at desc, then created_at desc.
 * Returns null when no outcomes have been written yet.
 */
export async function getRecentValidationOutcomes(limit = 20) {
    try {
        const db   = await getDb()
        const docs = await db.collection(COLLECTIONS.VALIDATION_OUTCOMES)
            .find(
                { new_status: { $in: ['confirmed', 'rejected'] } },
                { sort: { validated_at: -1, created_at: -1 }, projection: { _id: 0 }, limit },
            )
            .toArray()
        return docs.length ? docs : null
    } catch (err) {
        logger.warn(LOG, 'getRecentValidationOutcomes failed', err.message)
        return null
    }
}

/**
 * Active predicted signals from B1a (news-fired, pre-FRED-confirmation).
 * The B1 side of the prediction/confirmation pair.
 * Optionally filtered by agent ("mentor" | "atlas" | null = all active).
 * Returns null when no active signals exist.
 */
export async function getActivePredictedSignals(agent = null) {
    try {
        const db     = await getDb()
        const filter = { status: 'active' }
        if (agent) filter.agent = agent
        const docs = await db.collection(COLLECTIONS.PREDICTED_SIGNALS)
            .find(filter, { sort: { confidence_llm: -1, created_at: -1 }, projection: { _id: 0 } })
            .toArray()
        return docs.length ? docs : null
    } catch (err) {
        logger.warn(LOG, 'getActivePredictedSignals failed', err.message)
        return null
    }
}

/**
 * Active opportunity cards from D2 card_writer (FRED-confirmed).
 * Optionally filtered by agent ("mentor" | "atlas" | null = all active).
 * Returns null when no active cards exist.
 */
export async function getActiveOpportunities(agent = null) {
    try {
        const db     = await getDb()
        const filter = { status: 'active' }
        if (agent) filter.agent = agent
        const docs = await db.collection(COLLECTIONS.OPPORTUNITIES)
            .find(filter, { projection: { _id: 0 } })
            .sort({ confidence_llm: -1, validated_at: -1 })
            .toArray()
        logger.info(LOG, `getActiveOpportunities: ${docs.length} doc(s)`)
        return docs.length ? docs : null
    } catch (err) {
        logger.warn(LOG, 'getActiveOpportunities failed', err.message)
        return null
    }
}

/**
 * Latest predicted channel state (news-adjusted z-scores between FRED releases), or null.
 * Document shape: { channels, fred_anchor, news_delta_applied, fred_date, run_date, updated_at }
 * Written by B1c in the Python compute repo after each news ingest run.
 */
export async function getPredictedChannelState() {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTIONS.PREDICTED_CHANNEL_STATE)
            .findOne({ _id: 'latest' }, { projection: { _id: 0 } })
        return doc ?? null
    } catch (err) {
        logger.warn(LOG, 'getPredictedChannelState failed', err.message)
        return null
    }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Active opportunity cards + predicted signals for a specific ticker.
 * Used by Prometheus when revising a coverage that appears in the shock feed.
 */
export async function getOpportunityCardsByTicker(ticker) {
    try {
        const upper = ticker.toUpperCase()
        const db = await getDb()
        const [opportunities, signals] = await Promise.all([
            db.collection(COLLECTIONS.OPPORTUNITIES)
                .find({ ticker: upper, status: 'active' }, { projection: { _id: 0 } })
                .sort({ confidence_llm: -1 })
                .toArray(),
            db.collection(COLLECTIONS.PREDICTED_SIGNALS)
                .find({ ticker: upper, status: 'active' }, { projection: { _id: 0 } })
                .sort({ confidence_llm: -1 })
                .toArray(),
        ])
        return { opportunities, signals }
    } catch (err) {
        logger.warn(LOG, 'getOpportunityCardsByTicker failed', err.message)
        return { opportunities: [], signals: [] }
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
