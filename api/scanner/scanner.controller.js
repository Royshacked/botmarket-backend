import { scannerAgentService } from '../../services/scanner.agent.service.js'
import { scannerChatService }  from './scannerChat.service.js'
import { scanService }         from './scan.service.js'
import { logger }              from '../../services/logger.service.js'

const LOG = '[scanner:controller]'

export async function streamScanner(req, res) {
    const { messages, model, editList, reasoningEffort } = req.body ?? {}

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages must be a non-empty array' })
    }

    res.setHeader('Content-Type',  'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection',    'keep-alive')
    res.flushHeaders()

    function sendEvent(event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    // User hit Stop → the browser aborts the fetch and the connection closes.
    // Abort the agent loop so it stops generating instead of finishing silently.
    // NOTE: listen on res, not req — req's 'close' fires as soon as the request
    // body is fully received (Node ≥ ~18), which would abort every stream instantly.
    // res 'close' fires only when the response connection actually closes.
    const ac = new AbortController()
    let finished = false
    res.on('close', () => { if (!finished) ac.abort() })

    try {
        const result = await scannerAgentService.chatStream({
            messages,
            model,
            editList: editList && typeof editList === 'object' ? editList : null,
            reasoningEffort,
            signal:   ac.signal,
            onToken:  (text)   => sendEvent('token',  { text }),
            onTicker: (symbol) => sendEvent('ticker', { symbol }),
            onToolStart: (tool) => sendEvent('status', { tool }),
        })

        finished = true
        if (!ac.signal.aborted) {
            sendEvent('done', { reply: result.reply, scan: result.scan ?? null })
            res.end()
        }
    } catch (err) {
        finished = true
        if (ac.signal.aborted) return   // client gone — nothing to send
        logger.error(LOG, 'Scanner stream failed', err)
        sendEvent('error', { message: 'Streaming failed' })
        res.end()
    }
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
        if (!result.ok) return res.status(result.reason === 'forbidden' ? 403 : 404).json({ error: result.reason || 'Failed to update' })
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
        if (!result.ok) return res.status(result.reason === 'forbidden' ? 403 : 404).json({ error: result.reason || 'Failed to delete' })
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

export async function getScannerChatState(req, res) {
    try {
        const chatState = await scannerChatService.getChatState(req.user._id)
        res.json({ chatState: chatState ?? null })
    } catch (err) {
        logger.error(LOG, 'getScannerChatState failed', err)
        res.status(500).json({ error: 'Failed to get chat state' })
    }
}

export async function deleteScannerChatState(req, res) {
    try {
        await scannerChatService.deleteChatState(req.user._id)
        res.json({ ok: true })
    } catch (err) {
        logger.error(LOG, 'deleteScannerChatState failed', err)
        res.status(500).json({ error: 'Failed to delete chat state' })
    }
}
