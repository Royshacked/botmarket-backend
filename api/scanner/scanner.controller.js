import { scannerAgentService } from '../../services/agents/scanner.agent.service.js'
import { scannerChatService }  from './scannerChat.service.js'
import { scanService }         from './scan.service.js'
import { logger }              from '../../services/logger.service.js'
import { streamAgentResponse } from '../_shared/sse.util.js'
import { parseChatMessages }   from '../_shared/parse.util.js'
import { makeGetChatState, makeDeleteChatState } from '../_shared/chatState.util.js'
import { sendReason }          from '../_shared/reason.util.js'
import { makeEntityController } from '../_shared/entityController.util.js'
import { getExperienceLevel } from '../../services/experience.service.js'

const LOG = '[scanner:controller]'

export async function streamScanner(req, res) {
    const { messages, model, editList, handoff, handoffTo, profile } = req.body ?? {}

    const validatedMessages = parseChatMessages(messages)
    if (validatedMessages.error) {
        return res.status(400).json({ error: validatedMessages.error })
    }

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const result = await scannerAgentService.chatStream({
                audience:  await getExperienceLevel(req.user._id),
                messages,
                model,
                editList:        editList && typeof editList === 'object' ? editList : null,
                handoff:         handoff === true,
                // Which desk the pick goes back to — the CLIENT knows, because it is the pipeline's
                // next step. Whitelisted rather than passed through: this string lands in the prompt,
                // and an unknown value degrades to the generic phrasing instead of putting whatever
                // the body carried in front of the user.
                handoffTo:       handoffTo === 'mentor' || handoffTo === 'kairos' ? handoffTo : null,
                profile:         profile === 'investing' ? 'investing' : 'trading',
                userId:   req.user._id,
                signal:   signal,
                onToken:     (text)   => sendEvent('token',     { text }),
                onTicker:    (symbol) => sendEvent('ticker',    { symbol }),
                onPhase:     (phase)  => sendEvent('phase',     { phase }),
                onToolStart: (tool)   => sendEvent('status',    { tool }),
                onReasoning: (text)   => sendEvent('reasoning', { text }),
                onChart:     (chart)  => sendEvent('chart',     chart),
            })

            // `kairos_pick` (hand-off mode) → the single ticker Argus recommends back to Kairos.
            return { reply: result.reply, scan: result.scan ?? null, phase: result.phase ?? null, ...(result.pick ? { kairos_pick: result.pick } : {}) }
        },
    })
}

// ─── Scan CRUD ────────────────────────────────────────────────────────────────
export async function createScan(req, res) {
    try {
        const { scan } = req.body ?? {}
        if (!scan || !Array.isArray(scan.candidates) || scan.candidates.length === 0) {
            return res.status(400).json({ error: 'scan with candidates is required' })
        }
        const result = await scanService.saveScan(scan, req.user._id)
        if (!result.ok) return res.status(500).json({ error: 'Failed to save scan' })
        res.json({ scan: result.doc })
    } catch (err) {
        logger.error(LOG, 'createScan failed', err)
        res.status(500).json({ error: 'Failed to save scan' })
    }
}

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

export async function updateScan(req, res) {
    try {
        const { id }   = req.params
        const { scan } = req.body ?? {}
        if (!scan || typeof scan !== 'object') return res.status(400).json({ error: 'scan patch is required' })
        const result = await scanService.updateScan(id, scan, req.user._id)
        if (!result.ok) return sendReason(res, result.reason, { fallback: 500, fallbackMessage: 'Failed to update scan' })
        res.json({ scan: result.doc })
    } catch (err) {
        logger.error(LOG, 'updateScan failed', err)
        res.status(500).json({ error: 'Failed to update scan' })
    }
}

// ─── Chat state ───────────────────────────────────────────────────────────────
export async function saveScannerChatState(req, res) {
    try {
        const { messages } = req.body ?? {}
        if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' })
        const result = await scannerChatService.saveChatState(req.user._id, messages)
        if (!result.ok) return res.status(500).json({ error: 'Failed to save' })
        res.json({ ok: true })
    } catch (err) {
        logger.error(LOG, 'saveScannerChatState failed', err)
        res.status(500).json({ error: 'Failed to save chat state' })
    }
}

export const getScannerChatState = makeGetChatState({
    service: scannerChatService,
    keyArgs: (req) => [req.user._id],
    logger, log: LOG, failMsg: 'getScannerChatState failed',
})

export const deleteScannerChatState = makeDeleteChatState({
    service: scannerChatService,
    keyArgs: (req) => [req.user._id],
    logger, log: LOG, failMsg: 'deleteScannerChatState failed',
})
