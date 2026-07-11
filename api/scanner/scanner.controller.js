import { scannerAgentService } from '../../services/scanner.agent.service.js'
import { scannerChatService }  from './scannerChat.service.js'
import { scanService }         from './scan.service.js'
import { logger }              from '../../services/logger.service.js'
import { resolveModel }        from '../../services/modelRouter.service.js'
import { streamAgentResponse } from '../_shared/sse.util.js'
import { parseChatMessages }   from '../_shared/parse.util.js'
import { makeGetChatState, makeDeleteChatState } from '../_shared/chatState.util.js'
import { reasonToStatus }      from '../_shared/reason.util.js'

const LOG = '[scanner:controller]'

export async function streamScanner(req, res) {
    const { messages, model, editList, reasoningEffort, routingMode, currentPhase } = req.body ?? {}

    const validatedMessages = parseChatMessages(messages)
    if (validatedMessages.error) {
        return res.status(400).json({ error: validatedMessages.error })
    }

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const lastMessage = messages.at(-1)?.content ?? ''
            const routing = await resolveModel({ routingMode, agent: 'scanner', phase: currentPhase, model, reasoningEffort, lastMessage })

            const result = await scannerAgentService.chatStream({
                messages,
                model:           routing.model,
                editList:        editList && typeof editList === 'object' ? editList : null,
                reasoningEffort: routing.reasoningEffort,
                userId:   req.user._id,
                signal:   signal,
                onToken:     (text)   => sendEvent('token',     { text }),
                onTicker:    (symbol) => sendEvent('ticker',    { symbol }),
                onPhase:     (phase)  => sendEvent('phase',     { phase }),
                onToolStart: (tool)   => sendEvent('status',    { tool }),
                onReasoning: (text)   => sendEvent('reasoning', { text }),
            })

            return { reply: result.reply, scan: result.scan ?? null, phase: result.phase ?? null }
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
        res.json({ scan: result.scan })
    } catch (err) {
        logger.error(LOG, 'createScan failed', err)
        res.status(500).json({ error: 'Failed to save scan' })
    }
}

export async function listScans(req, res) {
    try {
        const scans = await scanService.getScans(req.user._id, req.user.isAdmin)
        res.json({ scans })
    } catch (err) {
        logger.error(LOG, 'listScans failed', err)
        res.status(500).json({ error: 'Failed to list scans' })
    }
}

export async function updateScan(req, res) {
    try {
        const { id }   = req.params
        const { scan } = req.body ?? {}
        if (!scan || typeof scan !== 'object') return res.status(400).json({ error: 'scan patch is required' })
        const result = await scanService.updateScan(id, scan, req.user._id, req.user.isAdmin)
        if (!result.ok) return res.status(reasonToStatus(result.reason, 404)).json({ error: result.reason || 'Failed to update' })
        res.json({ scan: result.scan })
    } catch (err) {
        logger.error(LOG, 'updateScan failed', err)
        res.status(500).json({ error: 'Failed to update scan' })
    }
}

export async function removeScan(req, res) {
    try {
        const { id } = req.params
        const result = await scanService.deleteScan(id, req.user._id, req.user.isAdmin)
        if (!result.ok) return res.status(reasonToStatus(result.reason, 404)).json({ error: result.reason || 'Failed to delete' })
        res.json({ ok: true })
    } catch (err) {
        logger.error(LOG, 'removeScan failed', err)
        res.status(500).json({ error: 'Failed to delete scan' })
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
