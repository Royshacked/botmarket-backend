// Pythia's weekly industry screen — the published verdict per GICS sub-industry: whether to trade it
// now, and on which horizon (docs/design/industry-screener.md; Roy's decision 2026-10-08 that everything
// lives under Pythia).
//
// One document per engine run date in `industry_screen`, owned by the house (no userId — a broadcast,
// like the industry views). Each holds every sub-industry's row: the engine's numbers, Pythia's catalyst
// score (Q11) and notes where it looked, the bucket computed from both, and the change since the
// previous screen. A screen is written once per run date and never edited: next week is a new document,
// so the history is the list of documents.

import { getDb } from '../../providers/mongodb.provider.js'

export const COLLECTION = 'industry_screen'

const _io = { db: () => getDb() }
/** Test seam. */
export function _setScreenIO(io) { Object.assign(_io, io) }

/** Once, at boot (server.js), like every other collection's ensure*Indexes. */
export async function ensureIndustryScreenIndexes() {
    const db = await _io.db()
    await db.collection(COLLECTION).createIndex({ asof: 1 }, { unique: true })
}

async function getScreen(asof) {
    const db = await _io.db()
    return db.collection(COLLECTION).findOne({ asof }, { projection: { _id: 0 } })
}

/** The newest screen, or the newest one BEFORE `asof` when given. */
async function latestScreen(before = null) {
    const db = await _io.db()
    return db.collection(COLLECTION).find(before ? { asof: { $lt: before } } : {}, { projection: { _id: 0 } })
        .sort({ asof: -1 }).limit(1).next()
}

/** Write a screen. Replaces a screen of the same date (a forced rerun); never touches another date. */
async function saveScreen(doc) {
    const db = await _io.db()
    await db.collection(COLLECTION).replaceOne({ asof: doc.asof }, doc, { upsert: true })
    return doc
}

export const industryScreenService = { getScreen, latestScreen, saveScreen }
