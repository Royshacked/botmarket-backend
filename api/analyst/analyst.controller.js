// HTTP handlers for the Analyst: the streaming research agent (P3) + coverage CRUD (P1) +
// research queue (Argus→Prometheus admin pipeline).
import { coverageService }        from './coverage.service.js'
import { researchQueueService }   from '../../services/researchQueue.service.js'
import { analystAgentService }    from '../../services/agents/analyst.agent.service.js'
import { streamAgentResponse, sseAgentCallbacks } from '../_shared/sse.util.js'
import { parseChatMessages }      from '../_shared/parse.util.js'
import { sendReason }             from '../_shared/reason.util.js'
import { logger }                 from '../../services/logger.service.js'
import { getExperienceLevel }     from '../../services/experience.service.js'
import { sanitizeScanSeed }       from '../../services/scanSeed.util.js'

const LOG = '[analystCtrl]'

export const _sanitizeAnalystSeed = sanitizeScanSeed

export async function streamAnalyst(req, res) {
    const { messages, userPrompt, model, chatState } = req.body ?? {}
    const seed = _sanitizeAnalystSeed(req.body?.seed)
    if (messages !== undefined && messages !== null) {
        const v = parseChatMessages(messages)
        if (v.error) return res.status(400).json({ error: v.error })
    }
    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const result = await analystAgentService.chatStream({
                audience:  await getExperienceLevel(req.user._id),
                messages,
                userPrompt,
                chatState:     (chatState && typeof chatState === 'object') ? chatState : {},
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

export async function listResearchQueue(req, res) {
    const { status } = req.query
    const docs = await researchQueueService.listQueue({ status: status ?? undefined })
    res.json(docs)
}

export async function enqueueResearch(req, res) {
    const { symbol, source } = req.body ?? {}
    if (!symbol) return res.status(400).json({ error: 'symbol is required' })
    const result = await researchQueueService.enqueue({
        symbol,
        source:      source ?? 'manual',
        requestedBy: req.user._id,
    })
    if (!result.ok) return res.status(500).json({ error: 'Failed to enqueue', reason: result.reason })
    res.status(result.duplicate ? 200 : 201).json(result)
}

export async function startResearch(req, res) {
    const result = await researchQueueService.startResearch(req.params.id)
    if (!result.ok) return res.status(result.reason === 'not_found_or_wrong_status' ? 404 : 500).json(result)
    res.json(result.doc)
}

export async function completeResearch(req, res) {
    const result = await researchQueueService.markDone(req.params.id)
    if (!result.ok) return res.status(result.reason === 'not_found_or_wrong_status' ? 404 : 500).json(result)
    res.json(result.doc)
}

export async function rejectResearch(req, res) {
    const result = await researchQueueService.reject(req.params.id)
    if (!result.ok) return res.status(result.reason === 'not_found_or_wrong_status' ? 404 : 500).json(result)
    res.json(result.doc)
}
