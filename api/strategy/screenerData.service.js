// The engine's weekly price run — the read side (docs/design/pythia-assessment.md §4.2 and §8).
//
// aether-engine writes, weekly (scripts/run_screener_timing.py):
//   industry_timing       one row per GICS sub-industry per run: how far its basket has moved (12/24 months
//                         against SPY, the last 1 and 3 months against the S&P), how stretched it is, the
//                         hype flag, and the older timing and quality scores
//   market_regime         one document per run date
//   industry_timing_runs  each run and its coverage (a PARTIAL run is never read)
//
// DATA, not judgment: Pythia's assessments state these numbers as facts (industryAssessment.factsFor), and the
// weekly change scan compares them with what each assessment was made on (changeScan). The weekly SCREEN that
// turned them into buckets was retired on 2026-10-11 (pythia-assessment.md step 6); the engine job and these
// reads stay. All three collections live in the ENGINE's database (services/engineDb.js).

import { getEngineDb } from '../../services/engineDb.js'

export const TIMING = 'industry_timing'
export const REGIME = 'market_regime'
export const TIMING_RUNS = 'industry_timing_runs'

// ─── reads ────────────────────────────────────────────────────────────────────

const _io = { db: () => getEngineDb() }
/** Test seam. */
export function _setScreenerIO(io) { Object.assign(_io, io) }

/** The latest COMPLETE (non-partial) engine run → `{ asof, run }` or null. */
export async function latestRun() {
    const db = await _io.db()
    const run = await db.collection(TIMING_RUNS).find({ partial: false }).sort({ asof: -1, finished_at: -1 }).limit(1).next()
    return run ? { asof: run.asof, run } : null
}

/** Every industry_timing row and the regime for one run date. */
export async function readRun(asof) {
    const db = await _io.db()
    const [rows, regime] = await Promise.all([
        db.collection(TIMING).find({ asof }, { projection: { _id: 0 } }).toArray(),
        db.collection(REGIME).findOne({ _id: asof }),
    ])
    return { rows, regime }
}

/**
 * One sub-industry's row from the latest COMPLETE run, and that run's regime → `{ row, regime }`, either
 * null when missing. For Pythia's assessment (pythia-assessment.md §4.2): how far the price has moved.
 */
export async function readTimingRow(code) {
    const latest = await latestRun()
    if (!latest) return { row: null, regime: null }
    const db = await _io.db()
    const [row, regime] = await Promise.all([
        db.collection(TIMING).findOne({ asof: latest.asof, code }, { projection: { _id: 0 } }),
        db.collection(REGIME).findOne({ _id: latest.asof }),
    ])
    return { row, regime }
}

/**
 * Several sub-industries' rows from ONE latest complete run, and its regime → `{ rows: Map(code → row),
 * regime }` — so a theme's links all come from the same run (a per-link read could straddle a run that
 * completed mid-way), in one query.
 */
export async function readTimingRows(codes) {
    const latest = await latestRun()
    if (!latest || !codes?.length) return { rows: new Map(), regime: null }
    const db = await _io.db()
    const [rows, regime] = await Promise.all([
        db.collection(TIMING).find({ asof: latest.asof, code: { $in: [...codes] } }, { projection: { _id: 0 } }).toArray(),
        db.collection(REGIME).findOne({ _id: latest.asof }),
    ])
    return { rows: new Map(rows.map(r => [r.code, r])), regime }
}
