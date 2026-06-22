// Persistence for generated scan lists. A scan is identified by its period
// (resolved dates) and thesis, and holds rich per-candidate analysis so a later
// trade-idea chat can be pre-loaded from a clicked candidate.

import { getDb }   from '../../providers/mongodb.provider.js'
import { logger }  from '../../services/logger.service.js'

const LOG        = '[scan]'
const COLLECTION = 'scans'

export const scanService = { saveScan, getScans, getScanById, updateScan, deleteScan }

const _strip = (doc) => { if (!doc) return doc; const { _id, ...rest } = doc; return rest }

async function saveScan(scan, userId) {
    try {
        const db  = await getDb()
        const doc = {
            id:         `scan_${Date.now()}`,
            userId:     userId ?? null,
            period:     scan.period     ?? { label: '', start: null, end: null },
            thesis:     scan.thesis     ?? 'Scan',
            direction:  scan.direction  ?? 'mixed',
            candidates: Array.isArray(scan.candidates) ? scan.candidates : [],
            // The scanner conversation that produced this list — lets the user
            // click the thesis to return to that chat.
            chat:       Array.isArray(scan.chat) ? scan.chat : [],
            savedAt:    Date.now(),
        }
        await db.collection(COLLECTION).insertOne(doc)
        logger.info(LOG, 'Scan saved', { id: doc.id, candidates: doc.candidates.length })
        return { ok: true, scan: _strip(doc) }
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
        return rows.map(_strip)
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
        return { ok: true, scan: _strip(scan) }
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
        if (Array.isArray(patch.candidates)) set.candidates = patch.candidates
        if (Array.isArray(patch.chat))       set.chat       = patch.chat

        const updated = await db.collection(COLLECTION).findOneAndUpdate(
            { id }, { $set: set }, { returnDocument: 'after' }
        )
        logger.info(LOG, 'Scan updated', { id, candidates: set.candidates?.length })
        return { ok: true, scan: _strip(updated) }
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
