// HTTP handlers for the Analyst: the streaming research agent (P3) + coverage CRUD (P1).
import { coverageService }    from './coverage.service.js'
import { analystAgentService } from '../../services/analyst.agent.service.js'
import { streamAgentResponse } from '../_shared/sse.util.js'
import { parseChatMessages }   from '../_shared/parse.util.js'
import { logger }             from '../../services/logger.service.js'

const LOG = '[analystCtrl]'

// Streaming research chat → emits a <coverage> draft (returned for preview; POST /coverage initiates it).
export async function streamAnalyst(req, res) {
    const { messages, userPrompt, model, reasoningEffort, chatState, brokerContext } = req.body ?? {}
    if (messages !== undefined && messages !== null) {
        const v = parseChatMessages(messages)
        if (v.error) return res.status(400).json({ error: v.error })
    }
    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const result = await analystAgentService.chatStream({
                messages,
                userPrompt,
                chatState:     (chatState && typeof chatState === 'object') ? chatState : {},
                brokerContext: brokerContext ?? null,
                model,
                reasoningEffort,
                userId: req.user._id,
                signal,
                onToken:     text  => sendEvent('token',     { text }),
                onPhase:     phase => sendEvent('phase',     { phase }),
                onToolStart: tool  => sendEvent('status',    { tool }),
                onReasoning: text  => sendEvent('reasoning', { text }),
            })
            return { reply: result.reply, phase: result.phase ?? null, ...(result.coverage ? { coverage: result.coverage } : {}) }
        },
    })
}

// reason → HTTP status for the CRUD result envelope.
const STATUS = { symbol_required: 400, already_covered: 409, not_found: 404, forbidden: 403 }
const _http = reason => STATUS[reason] ?? 400

export async function listCoverage(req, res) {
    try {
        const { sector, status } = req.query ?? {}
        const rows = await coverageService.getCoverage(req.user._id, { sector, status }, req.user.isAdmin)
        res.send(rows)
    } catch (err) {
        logger.error(LOG, 'listCoverage failed', err)
        res.status(500).send({ error: 'Failed to list coverage' })
    }
}

export async function getCoverageOne(req, res) {
    const result = await coverageService.getCoverageById(req.params.id, req.user._id, req.user.isAdmin)
    if (!result.ok) return res.status(result.reason ? _http(result.reason) : 500).send({ error: result.reason ?? 'get_failed' })
    res.send(result.coverage)
}

export async function initiateCoverage(req, res) {
    const { coverage } = req.body ?? {}
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
        return res.status(400).send({ error: 'coverage must be an object' })
    }
    const result = await coverageService.initiateCoverage(coverage, req.user._id)
    if (!result.ok) return res.status(result.reason ? _http(result.reason) : 500).send({ error: result.reason ?? 'initiate_failed', id: result.id })
    res.send(result.coverage)
}

export async function updateCoverage(req, res) {
    const patch = req.body?.patch ?? req.body
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return res.status(400).send({ error: 'patch must be an object' })
    }
    const result = await coverageService.updateCoverage(req.params.id, patch, req.user._id, req.user.isAdmin)
    if (!result.ok) return res.status(result.reason ? _http(result.reason) : 500).send({ error: result.reason ?? 'update_failed' })
    res.send(result.coverage)
}

export async function retireCoverage(req, res) {
    const result = await coverageService.retireCoverage(req.params.id, req.user._id, req.user.isAdmin)
    if (!result.ok) return res.status(result.reason ? _http(result.reason) : 500).send({ error: result.reason ?? 'retire_failed' })
    res.send(result.coverage)
}
