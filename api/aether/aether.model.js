// Aether — DB contract for the channel-graph forecasting engine.
//
// Node.js is READ-ONLY against these collections. Python writes on a schedule.
// Stubs return null when the engine has not yet run for a given collection.
// See docs/design/channel-graph-build-spec.md for the full schema per collection.

import { getDb } from '../../providers/mongodb.provider.js'

export const COLLECTIONS = {
    CHANNEL_STATE:   'aether_channel_state',
    REGIMES:         'aether_regimes',
    EXPOSURES:       'aether_exposures',
    FORECASTS:       'aether_forecasts',
    SITUATIONS:      'aether_situations',
    TAXONOMY:        'aether_taxonomy',
    BRIER_SCORES:    'aether_brier_scores',
    // Phase 7
    INTERFERENCE:    'aether_interference',
    PORTFOLIO_SLOTS: 'aether_portfolio_slots',
    LOSS_SURFACE:    'aether_loss_surface',
    // Phase 8
    EDGE_CANDIDATES: 'aether_edge_candidates',
    GOVERNANCE_LOG:  'aether_governance_log',
    DECAY_AUDIT:     'aether_decay_audit',
}

export async function ensureAetherIndexes() {
    const db = await getDb()
    // channel_state: one current-state record, read by label
    await db.collection(COLLECTIONS.CHANNEL_STATE).createIndex({ label: 1 }, { background: true })
    // regimes: current + historical; read latest
    await db.collection(COLLECTIONS.REGIMES).createIndex({ computed_at: -1 }, { background: true })
    // exposures: look up by entity ticker
    await db.collection(COLLECTIONS.EXPOSURES).createIndex({ ticker: 1 }, { background: true })
    // forecasts: read by entity and horizon
    await db.collection(COLLECTIONS.FORECASTS).createIndex({ entity: 1, resolution_date: 1 }, { background: true })
    // situations: active arcs
    await db.collection(COLLECTIONS.SITUATIONS).createIndex({ status: 1, updated_at: -1 }, { background: true })
    // taxonomy: one doc per channel_id
    await db.collection(COLLECTIONS.TAXONOMY).createIndex({ channel_id: 1 }, { unique: true, background: true })
    // brier scores: one doc per (channel_id, event_type, regime) — calibration status
    await db.collection(COLLECTIONS.BRIER_SCORES).createIndex(
        { channel_id: 1, event_type: 1, regime: 1 }, { unique: true, background: true }
    )
    // interference: cross-forecast interactions, read by run (computed_at) and severity
    await db.collection(COLLECTIONS.INTERFERENCE).createIndex({ computed_at: -1, severity: -1 }, { background: true })
    // portfolio slots: one per entity per run; read latest run then sort by weight
    await db.collection(COLLECTIONS.PORTFOLIO_SLOTS).createIndex({ entity: 1, forecast_id: 1 }, { unique: true, background: true })
    await db.collection(COLLECTIONS.PORTFOLIO_SLOTS).createIndex({ computed_at: -1, weight: -1 }, { background: true })
    // loss surface: one per run; read latest
    await db.collection(COLLECTIONS.LOSS_SURFACE).createIndex({ computed_at: -1 }, { background: true })
    // edge candidates: read by status (active pipeline) and by decided_at (budget window)
    await db.collection(COLLECTIONS.EDGE_CANDIDATES).createIndex({ candidate_id: 1 }, { unique: true, background: true })
    await db.collection(COLLECTIONS.EDGE_CANDIDATES).createIndex({ status: 1, admission_step: 1 }, { background: true })
    await db.collection(COLLECTIONS.EDGE_CANDIDATES).createIndex({ decided_at: -1 }, { background: true })
    // governance log: one row per event; read by candidate
    await db.collection(COLLECTIONS.GOVERNANCE_LOG).createIndex({ log_id: 1 }, { unique: true, background: true })
    await db.collection(COLLECTIONS.GOVERNANCE_LOG).createIndex({ candidate_id: 1, timestamp: 1 }, { background: true })
    // decay audit: batch per audit run; read latest batch via sentinel on audit_date
    await db.collection(COLLECTIONS.DECAY_AUDIT).createIndex({ audit_date: -1, recommendation: 1 }, { background: true })
}
