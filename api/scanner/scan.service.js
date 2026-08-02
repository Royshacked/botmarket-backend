// Persistence for generated scan lists. A scan is identified by its period
// (resolved dates) and thesis, and holds rich per-candidate analysis so a later
// trade-idea chat can be pre-loaded from a clicked candidate.

import { enrichWithProfiles } from '../../services/companyProfile.util.js'
import { makeEntityCrud }  from '../../services/entity/entityCrud.service.js'
import { logger }  from '../../services/logger.service.js'

const LOG        = '[scan]'
const COLLECTION = 'scans'

// Owner-scoped CRUD (the shared mechanism), the same factory the entity kinds and coverage use.
// A scan is not an execution-tier entity — it is a research artifact in its own collection — but
// it is an OWNER-SCOPED LIST, and that is what qualifies a caller here. No `kind` (the collection
// holds one thing), no deleteLock (a scan owns no broker position), default savedAt ordering.
//
// There is no admin bypass, here or anywhere in the owner-scoped layer: cross-user visibility is
// pinned off at the token, so every `isAdmin` branch was unreachable code that still read as live.
const crud = makeEntityCrud({ collection: COLLECTION, log: LOG })

export const scanService = { saveScan, getScans, getScanById, updateScan, deleteScan }

// A period-bound list whose end date has passed is STALE. This is a non-destructive
// flag DERIVED on read (never stored) so the UI can badge/sort it — the scan and its
// saved chat are kept until the user deletes them. Open-ended lists (no end date) are
// never stale. Dates are ISO YYYY-MM-DD, so a lexical compare is a date compare.
// Exported for unit testing.
export function _stampStale(scan, todayStr = new Date().toISOString().slice(0, 10)) {
    if (!scan || typeof scan !== 'object') return scan
    const end = scan.period?.end
    return { ...scan, stale: Boolean(typeof end === 'string' && end && end < todayStr) }
}

async function saveScan(scan, userId) {
    try {
        const doc = {
            id:         `scan_${Date.now()}`,
            userId:     userId ?? null,
            period:     scan.period     ?? { label: '', start: null, end: null },
            thesis:     scan.thesis     ?? 'Scan',
            direction:  scan.direction  ?? 'mixed',
            style:      scan.style       ?? null,
            // Which Argus profile produced this list (P4a). investing → the names route to the Analyst.
            profile:    scan.profile === 'investing' ? 'investing' : 'trading',
            // The SELECTION school it was screened under (investing lists only; normalized upstream).
            // Saved because it is what the ranking MEANS — the same names under a different school are
            // a different list, and one re-read months later has to say which bar it was held to.
            lens:       scan.lens        ?? null,
            candidates: Array.isArray(scan.candidates) ? scan.candidates : [],
            // The scanner conversation that produced this list — lets the user
            // click the thesis to return to that chat.
            chat:       Array.isArray(scan.chat) ? scan.chat : [],
            savedAt:    Date.now(),
        }
        // Attach company logos (+ fill missing names) so scan tickers render with
        // the same logo/name treatment as the calendar lists. Keyed on `ticker`;
        // the agent's candidate name is preserved when present.
        await enrichWithProfiles(doc.candidates, { key: 'ticker', overwriteName: false })
        const saved = await crud.insert(doc)
        logger.info(LOG, 'Scan saved', { id: doc.id, candidates: doc.candidates.length })
        return { ok: true, doc: _stampStale(saved) }
    } catch (err) {
        logger.error(LOG, 'Failed to save scan', err)
        return { ok: false, error: err }
    }
}

async function getScans(userId, { onError } = {}) {
    const today = new Date().toISOString().slice(0, 10)
    // Staleness is DERIVED on read, never stored — so it is stamped here rather than in the
    // shared crud, which knows nothing about periods.
    return (await crud.list(userId, { onError })).map(r => _stampStale(r, today))
}

// `{ ok, doc }` like every other service here — staleness stamped on the way out, since it is
// derived on read rather than stored.
async function getScanById(id, userId) {
    const res = await crud.getOwnedStripped(id, userId)
    return res.ok ? { ok: true, doc: _stampStale(res.doc) } : res
}

async function updateScan(id, patch, userId) {
    try {
        const found = await crud.getOwned(id, userId)
        if (!found.ok) return found

        const set = { updatedAt: Date.now() }
        if (patch.period    !== undefined)   set.period     = patch.period
        if (patch.thesis    !== undefined)   set.thesis     = patch.thesis
        if (patch.direction !== undefined)   set.direction  = patch.direction
        if (patch.style     !== undefined)   set.style      = patch.style
        if (patch.profile   !== undefined)   set.profile    = patch.profile === 'investing' ? 'investing' : 'trading'
        if (patch.lens      !== undefined)   set.lens       = patch.lens
        if (Array.isArray(patch.candidates)) {
            set.candidates = patch.candidates
            await enrichWithProfiles(set.candidates, { key: 'ticker', overwriteName: false })
        }
        if (Array.isArray(patch.chat))       set.chat       = patch.chat

        const res = await crud.patchOwned(id, userId, set)
        if (!res.ok) return res
        logger.info(LOG, 'Scan updated', { id, candidates: set.candidates?.length })
        return { ok: true, doc: _stampStale(res.doc) }
    } catch (err) {
        logger.error(LOG, 'Failed to update scan', err)
        return { ok: false, error: err }
    }
}

async function deleteScan(id, userId) {
    return crud.remove(id, userId)
}
