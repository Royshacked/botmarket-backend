import { scannerDesk }         from '../../services/desks/scanner.desk.js'
import { scanService }         from './scan.service.js'
import { makeDeskStream }      from '../_shared/deskStream.util.js'
import { sendReason }          from '../_shared/reason.util.js'
import { makeEntityController } from '../_shared/entityController.util.js'
import { makeHandle }          from '../_shared/handle.util.js'
import { httpError }           from '../../services/httpError.util.js'

const LOG    = '[scanner:controller]'
const handle = makeHandle(LOG)

// The desk itself is services/desks/scanner.desk.js, shared with the session turn (unified-chat plan phase 4).
export const streamScanner = makeDeskStream(scannerDesk)

// ─── Scan CRUD ────────────────────────────────────────────────────────────────
export const createScan = handle('createScan', async (req, res) => {
    const { scan } = req.body ?? {}
    if (!scan || !Array.isArray(scan.candidates) || scan.candidates.length === 0) {
        throw httpError(400, 'scan with candidates is required')
    }
    const result = await scanService.saveScan(scan, req.user._id)
    if (!result.ok) return res.status(500).json({ error: 'Failed to save scan' })
    res.json({ scan: result.doc })
})

// A scan is an owner-scoped kind like any other (it moved onto makeEntityCrud in b863a03), so
// list, get and delete are the shared HTTP tier. The `{scans}` / `{scan}` envelope is this route's
// own body shape, configured rather than re-implemented.
const crud = makeEntityController({
    log: LOG, noun: 'scan', envelope: { one: 'scan', many: 'scans' },
    service: {
        list:   (userId)     => scanService.getScans(userId),
        get:    (id, userId) => scanService.getScanById(id, userId),
        remove: (id, userId) => scanService.deleteScan(id, userId),
    },
})

export const listScans  = crud.list
export const getScan    = crud.get
export const removeScan = crud.remove

export const updateScan = handle('updateScan', async (req, res) => {
    const { id }   = req.params
    const { scan } = req.body ?? {}
    if (!scan || typeof scan !== 'object') throw httpError(400, 'scan patch is required')
    const result = await scanService.updateScan(id, scan, req.user._id)
    if (!result.ok) return sendReason(res, result.reason, { fallback: 500, fallbackMessage: 'Failed to update scan' })
    res.json({ scan: result.doc })
})
