// Generic thread write/read API over threadService. Agents whose server never sees
// the full conversation (idea sends userPrompt+analysisState; scanner trims) drive
// their own draft persistence from the client through these endpoints. Portfolio
// persists server-side inline (it already holds the full messages) — both paths land
// in the same `threads` store; only the write trigger differs.

import { threadService } from '../../services/thread.service.js'
import { isSubstantive } from '../../services/thread.util.js'
import { makeHandle }    from '../_shared/handle.util.js'
import { httpError }     from '../../services/httpError.util.js'

const LOG    = '[threads:controller]'
const handle = makeHandle(LOG)
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
//
// Live desks only. `idea` (deleted 2026-08-07) and `kairos` (archived 2026-08-18) were still here a
// month on; the one client path that saved under `idea` is MainPage's own dead `/api/idea` flow.
// Their old threads still READ — this gates writes, and nothing lists by it.
export const AGENTS = new Set(['portfolio', 'scanner', 'mentor', 'axl', 'analyst', 'strategy', 'aether'])

// The service answers `{ ok:false }` with no reason when its write failed — a fault, not a refusal.
// Thrown bare so the global handler answers the one 500 shape and the log names the handler.
const _failed = (what) => new Error(`threadService.${what} answered ok:false`)

export const saveDraftThread = handle('saveDraftThread', async (req, res) => {
    const { threadId, agent, messages, phase = null, subjectType = null, state = null, mandate = null, pipeline = null } = req.body ?? {}
    if (!threadId || typeof threadId !== 'string') throw httpError(400, 'threadId is required')
    if (!AGENTS.has(agent))       throw httpError(400, 'invalid agent')
    if (!Array.isArray(messages)) throw httpError(400, 'messages must be an array')

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
    if (!result.ok) throw _failed('saveDraft')
    res.json({ ok: true, threadId: result.threadId })
})

export const linkThread = handle('linkThread', async (req, res) => {
    const { threadId } = req.params
    const { subjectType = null, subjectId, artifactName = null } = req.body ?? {}
    if (!subjectId) throw httpError(400, 'subjectId is required')
    const result = await threadService.linkToArtifact({ threadId, userId: req.user._id, subjectType, subjectId, artifactName })
    if (!result.ok) throw _failed('linkToArtifact')
    res.json({ ok: true })
})

export const pinThread = handle('pinThread', async (req, res) => {
    const result = await threadService.pinThread({ threadId: req.params.threadId, userId: req.user._id })
    if (!result.ok) throw _failed('pinThread')
    res.json({ ok: true })
})

/**
 * Unfinished work across every desk — what the route badges read. Drafts only, each saying whether
 * it is waiting on the user.
 */
export const listUnfinishedThreads = handle('listUnfinishedThreads', async (req, res) => {
    res.json({ threads: await threadService.listUnfinished({ userId: req.user._id }) })
})

export const listThreads = handle('listThreads', async (req, res) => {
    const agent = typeof req.query.agent === 'string' ? req.query.agent : null
    res.json({ threads: await threadService.listThreads({ userId: req.user._id, agent }) })
})

export const getThread = handle('getThread', async (req, res) => {
    const thread = await threadService.getThread({ threadId: req.params.threadId, userId: req.user._id })
    if (!thread) throw httpError(404, 'Thread not found')
    res.json({ thread })
})

/**
 * The desk finished: its artifact exists, so the drafts that fed the run go with it. Drafts only —
 * the thread that AUTHORED the artifact was linked to it and is reached by editing that artifact.
 */
export const discardPipelineDrafts = handle('discardPipelineDrafts', async (req, res) => {
    const { pipeline } = req.params
    if (!pipeline || typeof pipeline !== 'string') throw httpError(400, 'pipeline is required')
    const result = await threadService.discardPipelineDrafts({ userId: req.user._id, pipeline })
    if (!result.ok) throw _failed('discardPipelineDrafts')
    res.json({ ok: true, deleted: result.deleted })
})

export const discardThread = handle('discardThread', async (req, res) => {
    const result = await threadService.discardThread({ threadId: req.params.threadId, userId: req.user._id })
    if (!result.ok) throw _failed('discardThread')
    res.json({ ok: true })
})
