// Aether — DB contract for the channel-graph forecasting engine.
//
// Node.js is READ-ONLY against these collections. Python writes on a schedule.
// Stubs return null when the engine has not yet run for a given collection.
// See docs/design/channel-graph-build-spec.md for the full schema per collection.

import { getDb } from '../../providers/mongodb.provider.js'

export const COLLECTIONS = {
    CHANNEL_STATE: 'aether_channel_state',
    REGIMES:       'aether_regimes',
    EXPOSURES:     'aether_exposures',
    FORECASTS:     'aether_forecasts',
    SITUATIONS:    'aether_situations',
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
}
