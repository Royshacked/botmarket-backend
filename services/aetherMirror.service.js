// Mirror one discovery run from the HOUSE database into the one this process is on.
//
// Aether is house research: one news queue, one set of runs, one candidate list, shared by
// every admin on every host. Since the laptop moved to its own database (axl_dev, 2026-09-19)
// the engine it spawns wrote there — into a cloned news queue nobody refreshes, and into a
// candidate list nobody on the deployed app can see. So the engine is pointed at the house
// database (config.aetherDb, `test`), and this copies what a run just wrote back into the
// local one, so the laptop's own Aether list shows it too. A COPY, not a second run: the run
// spends an Opus call per event and a few hundred SEC requests; running it twice to land in
// two databases would double both.
//
// What a run writes (aether-engine, select_events.py --run): one `aether_event_runs` row per
// selected event, its `aether_event_candidates` (keyed run_id + ticker; the price refresh at
// the end of the run updates the same rows), and one `aether_run_usage` row per run. The
// queue rows it marked as seen stay in the house queue — the local clone's queue is not read
// by anything that matters.
//
// Anything that happens to those rows LATER in the house database (the nightly refresh grading
// them, the scorecard) is not mirrored — the local copy is a snapshot at the end of the run,
// refreshed by re-cloning. Read-only against the source throughout.

import { logger } from './logger.service.js'

const LOG = '[aetherMirror]'

const RUNS       = 'aether_event_runs'
const CANDIDATES = 'aether_event_candidates'
const USAGE      = 'aether_run_usage'

const _strip = ({ _id, ...doc }) => doc   // eslint-disable-line no-unused-vars

async function _upsertAll(to, name, docs, keyOf) {
    if (!docs.length) return 0
    const ops = docs.map(d => ({ replaceOne: { filter: keyOf(d), replacement: _strip(d), upsert: true } }))
    const res = await to.collection(name).bulkWrite(ops, { ordered: false })
    return (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0)
}

/**
 * Copy the runs the engine recorded since `since` (ISO string — the spawn time), with their
 * candidates and usage, from `from` into `to`. Both are driver `Db` handles on the same client.
 * Returns the counts; never throws — a mirror that fails costs the laptop a list, not the run.
 */
export async function mirrorDiscoveryRuns({ from, to, since }) {
    const out = { runs: 0, candidates: 0, usage: 0 }
    try {
        // ISO-8601 strings compare lexically; the engine stamps UTC.
        const runs   = await from.collection(RUNS).find({ created_at: { $gte: since } }).toArray()
        const runIds = runs.map(r => r.run_id).filter(Boolean)
        if (!runIds.length) {
            logger.info(LOG, `nothing to mirror — no run recorded in ${from.databaseName} since ${since}`)
            return out
        }
        const [cands, usage] = await Promise.all([
            from.collection(CANDIDATES).find({ run_id: { $in: runIds } }).toArray(),
            from.collection(USAGE).find({ run_id: { $in: runIds } }).toArray(),
        ])
        out.runs       = await _upsertAll(to, RUNS,       runs,  d => ({ run_id: d.run_id }))
        out.candidates = await _upsertAll(to, CANDIDATES, cands, d => ({ run_id: d.run_id, ticker: d.ticker }))
        out.usage      = await _upsertAll(to, USAGE,      usage, d => ({ run_id: d.run_id }))
        logger.info(LOG, `mirrored ${from.databaseName} → ${to.databaseName}: ${runs.length} run(s), ${cands.length} candidate(s), ${usage.length} usage row(s)`)
    } catch (err) {
        logger.warn(LOG, `mirror failed (the run itself is stored in the house database): ${err.message}`)
    }
    return out
}
