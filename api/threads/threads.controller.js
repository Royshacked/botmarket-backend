// Generic thread write/read API over threadService. Agents whose server never sees
// the full conversation (idea sends userPrompt+analysisState; scanner trims) drive
// their own draft persistence from the client through these endpoints. Portfolio
// persists server-side inline (it already holds the full messages) — both paths land
// in the same `threads` store; only the write trigger differs.

import { threadService } from '../../services/thread.service.js'
import { isSubstantive } from '../../services/thread.util.js'
import { logger }        from '../../services/logger.service.js'

const LOG    = '[threads:controller]'
const AGENTS = new Set(['idea', 'portfolio', 'scanner', 'axl'])

export async function saveDraftThread(req, res) {
    try {
        const { threadId, agent, messages, phase = null, subjectType = null, state = null, mandate = null } = req.body ?? {}
        if (!threadId || typeof threadId !== 'string') return res.status(400).json({ error: 'threadId is required' })
        if (!AGENTS.has(agent))    return res.status(400).json({ error: 'invalid agent' })
        if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' })

        // Server-side floor (defense in depth — the client also gates): only persist once
        // the agent has emitted something substantive. Below it, silently no-op.
        const mandateReady = agent === 'portfolio' && !!(state?.mandate ?? mandate)
        if (!isSubstantive({ agent, phase, mandateReady })) {
            return res.json({ ok: true, skipped: true })
        }

        const result = await threadService.saveDraft({
            threadId, userId: req.user._id, agent, messages, phase, subjectType, state, mandate,
        })
        if (!result.ok) return res.status(500).json({ error: 'Failed to save draft' })
        res.json({ ok: true, threadId: result.threadId })
    } catch (err) {
        logger.error(LOG, 'saveDraftThread failed', err)
        res.status(500).json({ error: 'Failed to save draft' })
    }
}

export async function linkThread(req, res) {
    try {
        const { threadId } = req.params
        const { subjectType = null, subjectId, artifactName = null } = req.body ?? {}
        if (!subjectId) return res.status(400).json({ error: 'subjectId is required' })
        const result = await threadService.linkToArtifact({ threadId, userId: req.user._id, subjectType, subjectId, artifactName })
        if (!result.ok) return res.status(500).json({ error: 'Failed to link thread' })
        res.json({ ok: true })
    } catch (err) {
        logger.error(LOG, 'linkThread failed', err)
        res.status(500).json({ error: 'Failed to link thread' })
    }
}

export async function pinThread(req, res) {
    try {
        const result = await threadService.pinThread({ threadId: req.params.threadId, userId: req.user._id })
        if (!result.ok) return res.status(500).json({ error: 'Failed to pin thread' })
        res.json({ ok: true })
    } catch (err) {
        logger.error(LOG, 'pinThread failed', err)
        res.status(500).json({ error: 'Failed to pin thread' })
    }
}

export async function listThreads(req, res) {
    try {
        const agent = typeof req.query.agent === 'string' ? req.query.agent : null
        const threads = await threadService.listThreads({ userId: req.user._id, agent })
        res.json({ threads })
    } catch (err) {
        logger.error(LOG, 'listThreads failed', err)
        res.status(500).json({ error: 'Failed to list threads' })
    }
}

export async function getThread(req, res) {
    try {
        const thread = await threadService.getThread({ threadId: req.params.threadId, userId: req.user._id })
        if (!thread) return res.status(404).json({ error: 'Thread not found' })
        res.json({ thread })
    } catch (err) {
        logger.error(LOG, 'getThread failed', err)
        res.status(500).json({ error: 'Failed to get thread' })
    }
}

export async function discardThread(req, res) {
    try {
        const result = await threadService.discardThread({ threadId: req.params.threadId, userId: req.user._id })
        if (!result.ok) return res.status(500).json({ error: 'Failed to discard thread' })
        res.json({ ok: true })
    } catch (err) {
        logger.error(LOG, 'discardThread failed', err)
        res.status(500).json({ error: 'Failed to discard thread' })
    }
}
