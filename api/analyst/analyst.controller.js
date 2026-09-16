// HTTP handlers for the Analyst: the streaming research agent (P3) + coverage CRUD (P1) +
// research queue (Argus→Prometheus admin pipeline).
import { coverageService }        from './coverage.service.js'
import { researchQueueService }   from '../../services/researchQueue.service.js'
import { researchRunService }     from '../../services/researchRun.service.js'
import { analystAgentService }    from '../../services/agents/analyst.agent.service.js'
import { streamAgentResponse, sseAgentCallbacks } from '../_shared/sse.util.js'
import { parseChatMessages }      from '../_shared/parse.util.js'
import { sendReason }             from '../_shared/reason.util.js'
import { makeHandle }             from '../_shared/handle.util.js'
import { logger }                 from '../../services/logger.service.js'
import { getExperienceLevel }     from '../../services/experience.service.js'
import { sanitizeScanSeed }       from '../../services/scanSeed.util.js'

const LOG = '[analystCtrl]'
// The queue and run handlers below ride makeHandle. They used to have no try/catch at all and
// leaned on every service catching internally — true today, and one thrown read away from a hung
// request (Express 4 does not see an async rejection). Unlike the coverage handlers above them,
// which answer fixed slugs and wait on the §9 error-shape decision, these never caught, so the
// wrapper changes nothing the client sees; it adds the log line and the route to the global handler.
const _handle = makeHandle(LOG)

// Enrich chatState with coverage data from the DB so the agent always knows what's already
// covered — without depending on the frontend to send it. The frontend can still override
// by pre-populating either field; we only fill what's missing.
export async function _resolveCoverageContext(chatState, seed) {
    const state = { ...chatState }

    if (!state.coverage_symbols?.length) {
        try {
            const all = await coverageService.getCoverage()
            state.coverage_symbols = all.map(d => d.symbol)
        } catch (err) {
            logger.warn(LOG, '_resolveCoverageContext: getCoverage failed (non-fatal)', err.message)
        }
    }

    // Check the active ticker — seed hand-off takes precedence over chatState.active_symbol.
    const ticker = seed?.ticker
        ? String(seed.ticker).toUpperCase().trim()
        : chatState.active_symbol
            ? String(chatState.active_symbol).toUpperCase().trim()
            : null

    if (ticker && !state.existing_coverage) {
        try {
            const existing = await coverageService.getCoverageBySymbol(ticker)
            if (existing) state.existing_coverage = existing
        } catch (err) {
            logger.warn(LOG, '_resolveCoverageContext: getCoverageBySymbol failed (non-fatal)', err.message)
        }
    }

    return state
}

export async function streamAnalyst(req, res) {
    const { messages, userPrompt, model, chatState } = req.body ?? {}
    const seed = sanitizeScanSeed(req.body?.seed)
    if (messages !== undefined && messages !== null) {
        const v = parseChatMessages(messages)
        if (v.error) return res.status(400).json({ error: v.error })
    }

    const resolvedState = await _resolveCoverageContext(
        (chatState && typeof chatState === 'object') ? chatState : {},
        seed
    )

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const result = await analystAgentService.chatStream({
                audience:  await getExperienceLevel(req.user._id),
                messages,
                userPrompt,
                chatState:     resolvedState,
                seed,
                model,
                userId: req.user._id,
                signal,
                ...sseAgentCallbacks(sendEvent),
                onPhase:     phase => sendEvent('phase',     { phase }),
            })
            return { reply: result.reply, phase: result.phase ?? null, ...(result.coverage ? { coverage: result.coverage } : {}) }
        },
    })
}

// ─── Coverage CRUD ────────────────────────────────────────────────────────────

const COVERAGE_REASONS = {
    symbol_required:           [400, 'A symbol is required to initiate coverage'],
    already_covered:           [409, 'Already covered — update the thesis instead of initiating it again'],
    rating_contradicts_target: [422, 'The rating and the price target point in opposite directions'],
}

export async function listCoverage(req, res) {
    try {
        const docs = await coverageService.getCoverage({
            sector: req.query?.sector ?? null,
            status: req.query?.status ?? null,
        })
        res.send(docs)
    } catch (err) {
        logger.error(LOG, 'listCoverage failed', err)
        res.status(500).send({ error: 'Failed to list coverage' })
    }
}

export async function getCoverageOne(req, res) {
    try {
        const result = await coverageService.getCoverageById(req.params.id)
        if (!result.ok) return sendReason(res, result.reason, { overrides: COVERAGE_REASONS, fallback: 404, fallbackMessage: 'Not found' })
        res.send(result.doc)
    } catch (err) {
        logger.error(LOG, 'getCoverageOne failed', err)
        res.status(500).send({ error: 'Failed to get coverage' })
    }
}

export async function getCoverageBySymbol(req, res) {
    try {
        const doc = await coverageService.getCoverageBySymbol(req.params.symbol)
        if (!doc) return res.status(404).send({ error: 'Coverage not found' })
        res.send(doc)
    } catch (err) {
        logger.error(LOG, 'getCoverageBySymbol failed', err)
        res.status(500).send({ error: 'Failed to get coverage' })
    }
}

export async function initiateCoverage(req, res) {
    try {
        const { coverage } = req.body ?? {}
        if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
            return res.status(400).send({ error: 'coverage must be an object' })
        }
        const result = await coverageService.initiateCoverage(coverage)
        if (!result.ok) {
            return sendReason(res, result.reason, {
                overrides: COVERAGE_REASONS, fallback: 500, fallbackMessage: 'Failed to initiate coverage',
                extra: { ...(result.id ? { id: result.id } : {}), ...(result.detail ? { detail: result.detail } : {}) },
            })
        }
        res.send(result.doc)
    } catch (err) {
        logger.error(LOG, 'initiateCoverage failed', err)
        res.status(500).send({ error: 'Failed to initiate coverage' })
    }
}

export async function updateCoverage(req, res) {
    try {
        const patch = req.body?.patch ?? req.body
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            return res.status(400).send({ error: 'patch must be an object' })
        }
        const result = await coverageService.updateCoverage(req.params.id, patch)
        if (!result.ok) return sendReason(res, result.reason, {
            overrides: COVERAGE_REASONS, fallback: 500, fallbackMessage: 'Failed to update coverage',
            extra: result.detail ? { detail: result.detail } : null,
        })
        res.send(result.doc)
    } catch (err) {
        logger.error(LOG, 'updateCoverage failed', err)
        res.status(500).send({ error: 'Failed to update coverage' })
    }
}

export async function retireCoverage(req, res) {
    try {
        const result = await coverageService.retireCoverage(req.params.id)
        if (!result.ok) return sendReason(res, result.reason, { overrides: COVERAGE_REASONS, fallback: 500, fallbackMessage: 'Failed to retire coverage' })
        res.send(result.doc)
    } catch (err) {
        logger.error(LOG, 'retireCoverage failed', err)
        res.status(500).send({ error: 'Failed to retire coverage' })
    }
}

export async function deleteCoverage(req, res) {
    try {
        const result = await coverageService.deleteCoverage(req.params.id)
        if (!result.ok) return sendReason(res, result.reason, { overrides: COVERAGE_REASONS, fallback: 500, fallbackMessage: 'Failed to delete coverage' })
        logger.info(LOG, 'coverage deleted', { id: req.params.id })
        res.send({ ok: true })
    } catch (err) {
        logger.error(LOG, 'deleteCoverage failed', err)
        res.status(500).send({ error: 'Failed to delete coverage' })
    }
}

// ─── Research queue (Argus→Prometheus admin pipeline) ─────────────────────────

export const listResearchQueue = _handle('listResearchQueue', async (req, res) => {
    const { status } = req.query
    const docs = await researchQueueService.listQueue({ status: status ?? undefined })
    // null is a FAILED READ, not an empty queue — see the service. Reporting it as 503 rather than
    // as `[]` is what keeps "Argus queued nothing" distinguishable from "Mongo was unreachable".
    if (docs === null) return res.status(503).send({ error: 'Research queue unavailable' })
    res.json(docs)
})

export const enqueueResearch = _handle('enqueueResearch', async (req, res) => {
    const { symbol, source } = req.body ?? {}
    if (!symbol) return res.status(400).json({ error: 'symbol is required' })
    const result = await researchQueueService.enqueue({
        symbol,
        source:      source ?? 'manual',
        requestedBy: req.user._id,
    })
    if (!result.ok) return res.status(500).json({ error: 'Failed to enqueue', reason: result.reason })
    res.status(result.duplicate ? 200 : 201).json(result)
})

// The three transitions answer the same way: the guarded update matched nothing → 404, else 500.
const _transitionHandler = (label, move) => _handle(label, async (req, res) => {
    const result = await move(req.params.id)
    if (!result.ok) return res.status(result.reason === 'not_found_or_wrong_status' ? 404 : 500).json(result)
    res.json(result.doc)
})
export const startResearch    = _transitionHandler('startResearch',    (id) => researchQueueService.startResearch(id))
export const completeResearch = _transitionHandler('completeResearch', (id) => researchQueueService.markDone(id))
export const rejectResearch   = _transitionHandler('rejectResearch',   (id) => researchQueueService.reject(id))

// ─── Research run — the queue, researched headlessly ─────────────────────────
// See researchRun.service.js. One run at a time; the client polls the run (and the queue) for
// progress. The admin's venue and level are what the agent researches with, as at the desk.

const RUN_REASONS = {
    already_running:      [409, 'A research run is already going — stop it first'],
    nothing_queued:       [409, 'Nothing is queued'],
    queue_unavailable:    [503, 'Research queue unavailable'],
    coverage_unavailable: [503, 'Could not read the coverage book'],
    not_running:          [409, 'No research run is going'],
}

export const startResearchRun = _handle('startResearchRun', async (req, res) => {
    const result = await researchRunService.startRun({
        userId:   req.user._id,
        audience: await getExperienceLevel(req.user._id),
        model:    typeof req.body?.model === 'string' ? req.body.model : null,
    })
    if (!result.ok) return sendReason(res, result.reason, { overrides: RUN_REASONS, fallback: 500, fallbackMessage: 'Could not start the research run', extra: result.run ? { run: result.run } : {} })
    res.status(202).json(result.run)
})

export const getResearchRun = _handle('getResearchRun', (_req, res) => {
    res.json(researchRunService.getRun())   // null when no run has happened this process
})

export const stopResearchRun = _handle('stopResearchRun', (_req, res) => {
    const result = researchRunService.stopRun()
    if (!result.ok) return sendReason(res, result.reason, { overrides: RUN_REASONS, fallback: 500, fallbackMessage: 'Could not stop the research run' })
    res.json(result.run)
})

export const requeueStalledResearch = _handle('requeueStalledResearch', async (_req, res) => {
    const result = await researchRunService.requeueStalled()
    if (!result.ok) return sendReason(res, result.reason, { overrides: RUN_REASONS, fallback: 500, fallbackMessage: 'Could not requeue the claimed names' })
    res.json({ requeued: result.requeued })
})
