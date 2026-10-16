import { scannerAgentService } from '../../services/agents/scanner.agent.service.js'
import { scanService }         from './scan.service.js'
import { makeDeskStream }      from '../_shared/deskStream.util.js'
import { sendReason }          from '../_shared/reason.util.js'
import { makeEntityController } from '../_shared/entityController.util.js'
import { makeHandle }          from '../_shared/handle.util.js'
import { httpError }           from '../../services/httpError.util.js'

const LOG    = '[scanner:controller]'
const handle = makeHandle(LOG)

export const streamScanner = makeDeskStream({
    log: LOG,
    parse: (req) => {
        const { editList, handoff, handoffTo, radar, radarBoard, profile } = req.body ?? {}
        return {
            editList:   editList && typeof editList === 'object' ? editList : null,
            handoff:    handoff === true,
            // Which desk the pick goes back to — the CLIENT knows, because it is the pipeline's next
            // step. Whitelisted rather than passed through: this string lands in the prompt, and an
            // unknown value degrades to the generic phrasing instead of putting whatever the body
            // carried in front of the user.
            handoffTo:  handoffTo === 'mentor' ? handoffTo : null,
            // The Events radar handed over a universe: the mode flag, and the board it applies to.
            // The board is built server-side (aetherScanUniverse) and handed straight back, so the
            // only thing worth checking here is its shape — the prompt renders whatever it holds.
            radar:      radar === true,
            radarBoard: radarBoard && typeof radarBoard === 'object' ? radarBoard : null,
            profile:    profile === 'investing' ? 'investing' : 'trading',
        }
    },
    run: ({ extras, sendEvent, common }) => scannerAgentService.chatStream({
        ...common,
        ...extras,
        onTicker: (symbol) => sendEvent('ticker', { symbol }),
        onPhase:  (phase)  => sendEvent('phase',  { phase }),
    }),
    // `kairos_pick` (hand-off mode) → the single ticker Argus recommends back to the build desk.
    // The wire name outlived the desk it was written for; the client reads it by this name.
    done: (result) => ({ reply: result.reply, scan: result.scan ?? null, phase: result.phase ?? null, ...(result.pick ? { kairos_pick: result.pick } : {}) }),
})

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
