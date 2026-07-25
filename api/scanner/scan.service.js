// Persistence for generated scan lists. A scan is identified by its period
// (resolved dates) and thesis, and holds rich per-candidate analysis so a later
// trade-idea chat can be pre-loaded from a clicked candidate.

import { getDb, stripId }   from '../../providers/mongodb.provider.js'
import { enrichWithProfiles } from '../../services/companyProfile.util.js'
import { logger }  from '../../services/logger.service.js'

const LOG        = '[scan]'
const COLLECTION = 'scans'

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
        const db  = await getDb()
        const doc = {
            id:         `scan_${Date.now()}`,
            userId:     userId ?? null,
            period:     scan.period     ?? { label: '', start: null, end: null },
            thesis:     scan.thesis     ?? 'Scan',
            direction:  scan.direction  ?? 'mixed',
            style:      scan.style       ?? null,
            // Which Argus profile produced this list (P4a). investing → the names route to the Analyst.
            profile:    scan.profile === 'investing' ? 'investing' : 'trading',
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
        await db.collection(COLLECTION).insertOne(doc)
        logger.info(LOG, 'Scan saved', { id: doc.id, candidates: doc.candidates.length })
        return { ok: true, scan: _stampStale(stripId(doc)) }
    } catch (err) {
        logger.error(LOG, 'Failed to save scan', err)
        return { ok: false, error: err }
    }
}

async function getScans(userId, isAdmin = false) {
    try {
        const db    = await getDb()
        const query = isAdmin ? {} : { userId }
        const rows  = await db.collection(COLLECTION).find(query).sort({ savedAt: -1 }).toArray()
        const today = new Date().toISOString().slice(0, 10)
        return rows.map(r => _stampStale(stripId(r), today))
    } catch (err) {
        logger.error(LOG, 'Failed to get scans', err)
        return []
    }
}

async function getScanById(id, userId, isAdmin = false) {
    try {
        const db   = await getDb()
        const scan = await db.collection(COLLECTION).findOne({ id })
        if (!scan) return { ok: false, reason: 'not_found' }
        if (scan.userId && scan.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }
        return { ok: true, scan: _stampStale(stripId(scan)) }
    } catch (err) {
        logger.error(LOG, 'Failed to get scan by id', err)
        return { ok: false, error: err }
    }
}

async function updateScan(id, patch, userId, isAdmin = false) {
    try {
        const db   = await getDb()
        const scan = await db.collection(COLLECTION).findOne({ id })
        if (!scan) return { ok: false, reason: 'not_found' }
        if (scan.userId && scan.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }

        const set = { updatedAt: Date.now() }
        if (patch.period    !== undefined)   set.period     = patch.period
        if (patch.thesis    !== undefined)   set.thesis     = patch.thesis
        if (patch.direction !== undefined)   set.direction  = patch.direction
        if (patch.style     !== undefined)   set.style      = patch.style
        if (patch.profile   !== undefined)   set.profile    = patch.profile === 'investing' ? 'investing' : 'trading'
        if (Array.isArray(patch.candidates)) {
            set.candidates = patch.candidates
            await enrichWithProfiles(set.candidates, { key: 'ticker', overwriteName: false })
        }
        if (Array.isArray(patch.chat))       set.chat       = patch.chat

        const updated = await db.collection(COLLECTION).findOneAndUpdate(
            { id }, { $set: set }, { returnDocument: 'after' }
        )
        logger.info(LOG, 'Scan updated', { id, candidates: set.candidates?.length })
        return { ok: true, scan: _stampStale(stripId(updated)) }
    } catch (err) {
        logger.error(LOG, 'Failed to update scan', err)
        return { ok: false, error: err }
    }
}

async function deleteScan(id, userId, isAdmin = false) {
    try {
        const db   = await getDb()
        const scan = await db.collection(COLLECTION).findOne({ id })
        if (!scan) return { ok: false, reason: 'not_found' }
        if (scan.userId && scan.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }
        await db.collection(COLLECTION).deleteOne({ id })
        logger.info(LOG, 'Scan deleted', { id })
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to delete scan', err)
        return { ok: false, error: err }
    }
}
