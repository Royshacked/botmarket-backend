// Aether — DB contract for the event-exposure engine.
//
// Node.js is READ-ONLY against these collections. Python writes them, and only when an
// admin starts a discovery run.
//
// TWENTY COLLECTIONS WENT on 2026-09-09 with the channel-graph engine: channel state,
// regimes, exposures, supply edges, forecasts, situations, taxonomy, brier scores,
// interference, portfolio slots, loss surface, edge candidates, governance log, decay
// audit, predictions, validation outcomes, opportunities, predicted signals and predicted
// channel state. Their writers are archived, so the app declared indexes on collections
// nothing would ever write to again — harmless, and a map of an engine that no longer
// exists.
//
// What is left is the pipeline the desk actually runs: a run is one named event, a
// candidate is one company it reaches.

import { getDb } from '../../providers/mongodb.provider.js'

export const COLLECTIONS = {
    EVENT_RUNS:       'aether_event_runs',
    EVENT_CANDIDATES: 'aether_event_candidates',
}

export async function ensureAetherIndexes() {
    const db = await getDb()

    // The list is read by recency and, for the survivors-only default, by `survived`.
    await db.collection(COLLECTIONS.EVENT_CANDIDATES).createIndex(
        { created_at: -1 }, { background: true },
    )
    // One ticker appears across several events; "why is this name here" asks for all of them.
    await db.collection(COLLECTIONS.EVENT_CANDIDATES).createIndex(
        { ticker: 1 }, { background: true },
    )
    // The engine keys on (run_id, ticker) and upserts, so a re-run updates rather than
    // duplicates. Declared here too because whichever side connects first should create it.
    await db.collection(COLLECTIONS.EVENT_CANDIDATES).createIndex(
        { run_id: 1, ticker: 1 }, { unique: true, background: true },
    )
    // Runs are read newest-first, and the selector checks recent subjects to avoid
    // re-running a story that is still in the news.
    await db.collection(COLLECTIONS.EVENT_RUNS).createIndex(
        { created_at: -1 }, { background: true },
    )
}
