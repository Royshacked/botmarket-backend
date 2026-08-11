// Generic thread write/read API over threadService. Agents whose server never sees
// the full conversation (idea sends userPrompt+analysisState; scanner trims) drive
// their own draft persistence from the client through these endpoints. Portfolio
// persists server-side inline (it already holds the full messages) — both paths land
// in the same `threads` store; only the write trigger differs.

import { threadService } from '../../services/thread.service.js'
import { isSubstantive } from '../../services/thread.util.js'
import { logger }        from '../../services/logger.service.js'

const LOG    = '[threads:controller]'
// Every agent whose panel drives its own draft persistence. `mentor` was missing, so every Mentor
// save was rejected 400 and a setup the user walked out of mid-build vanished — the desk badge had
// nothing to read, the lock had nothing to close, and returning to the trade desk resumed the Argus
// step because the Mentor thread it should have picked up did not exist.
//
// `analyst` and `strategy` were missing for the same reason and cost the same thing (2026-08-11): both
// declare a desk in agentMeta, so the hub was asking for a marker and a lock that nothing could ever
// answer. THIS LIST IS THE SECOND HALF OF A PAIR — a panel that saves and an agent named here — and a
// new desk needs both. Neither half fails loudly on its own: a missing name is a silent 400, and a
// panel that never saves simply has nothing to reject.
export const AGENTS = new Set(['idea', 'portfolio', 'scanner', 'kairos', 'mentor', 'axl', 'analyst', 'strategy'])

export async function saveDraftThread(req, res) {
    try {
        const { threadId, agent, messages, phase = null, subjectType = null, state = null, mandate = null, pipeline = null } = req.body ?? {}
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
            // The desk this conversation belongs to — validated as a string, never trusted as a key.
            pipeline: typeof pipeline === 'string' && pipeline.trim() ? pipeline.trim() : null,
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

/**
 * Unfinished work across every desk — what the route badges read. Drafts only, each saying whether
 * it is waiting on the user.
 */
export async function listUnfinishedThreads(req, res) {
    try {
        res.json({ threads: await threadService.listUnfinished({ userId: req.user._id }) })
    } catch (err) {
        logger.error(LOG, 'listUnfinishedThreads failed', err)
        res.status(500).send({ error: 'Failed to list unfinished threads' })
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

/**
 * The desk finished: its artifact exists, so the drafts that fed the run go with it. Drafts only —
 * the thread that AUTHORED the artifact was linked to it and is reached by editing that artifact.
 */
export async function discardPipelineDrafts(req, res) {
    try {
        const { pipeline } = req.params
        if (!pipeline || typeof pipeline !== 'string') return res.status(400).json({ error: 'pipeline is required' })
        const result = await threadService.discardPipelineDrafts({ userId: req.user._id, pipeline })
        if (!result.ok) return res.status(500).json({ error: 'Failed to discard pipeline drafts' })
        res.json({ ok: true, deleted: result.deleted })
    } catch (err) {
        logger.error(LOG, 'discardPipelineDrafts failed', err)
        res.status(500).json({ error: 'Failed to discard pipeline drafts' })
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
