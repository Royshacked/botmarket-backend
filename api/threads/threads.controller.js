// The thread API that is left (unified-chat phase 9, 2026-10-20): Pythia's and Aether's panels keep their own
// chats in `threads` (phase 8e, D1) and drive their persistence from the client — save a draft, link it to what it
// produced, discard it. Every other desk talks in the session (api/sessions); the desks' list / get / pin / badge
// and pipeline-discard endpoints went with the panels that called them.

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
//
// Since the unified chat (phase 9, 2026-10-20) that is Pythia and Aether alone: every other desk talks in the
// session, its old threads were migrated off this store, and a draft saved under one of them would be legacy data
// written fresh — so the gate refuses it.
export const AGENTS = new Set(['strategy', 'aether'])

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

export const discardThread = handle('discardThread', async (req, res) => {
    const result = await threadService.discardThread({ threadId: req.params.threadId, userId: req.user._id })
    if (!result.ok) throw _failed('discardThread')
    res.json({ ok: true })
})
