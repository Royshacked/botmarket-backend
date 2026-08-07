// HTTP handlers for the Analyst: the streaming research agent (P3) + coverage CRUD (P1).
import { coverageService }    from './coverage.service.js'
import { analystAgentService } from '../../services/agents/analyst.agent.service.js'
import { streamAgentResponse } from '../_shared/sse.util.js'
import { parseChatMessages }   from '../_shared/parse.util.js'
import { sendReason }          from '../_shared/reason.util.js'
import { makeEntityController } from '../_shared/entityController.util.js'
import { logger }             from '../../services/logger.service.js'
import { getExperienceLevel } from '../../services/experience.service.js'

const LOG = '[analystCtrl]'

// A structured Argus INVESTING candidate seed (P4b): a hand-off arrives as a typed object, not free
// text. Kept lean + string-only; ticker required. Mirrors Kairos's _sanitizeSeed.
export function _sanitizeAnalystSeed(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const s = k => (typeof raw[k] === 'string' && raw[k].trim() ? raw[k].trim() : null)
    const ticker = s('ticker')
    if (!ticker) return null
    return { ticker: ticker.toUpperCase(), sector: s('sector'), thesis: s('thesis'), analysis: s('analysis') }
}

// Streaming research chat → emits a <coverage> draft (returned for preview; POST /coverage initiates it).
export async function streamAnalyst(req, res) {
    const { messages, userPrompt, model, reasoningEffort, chatState } = req.body ?? {}
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
                reasoningEffort,
                userId: req.user._id,
                signal,
                onToken:     text  => sendEvent('token',     { text }),
                onPhase:     phase => sendEvent('phase',     { phase }),
                onToolStart: tool  => sendEvent('status',    { tool }),
                onReasoning: text  => sendEvent('reasoning', { text }),
                onChart:     chart => sendEvent('chart',     chart),
            })
            return { reply: result.reply, phase: result.phase ?? null, ...(result.coverage ? { coverage: result.coverage } : {}) }
        },
    })
}

// ─── Coverage CRUD ────────────────────────────────────────────────────────────
// Coverage is owner-scoped like every other kind — its own collection, but the same crud factory
// and the same HTTP tier. What stays analyst-OWNED is one reason: initiation is an EVENT, so a
// second one on a name already covered is a conflict, not an update.
const COVERAGE_REASONS = {
    symbol_required: [400, 'A symbol is required to initiate coverage'],
    already_covered: [409, 'Already covered — update the thesis instead of initiating it again'],
    // The thesis contradicts itself — a buy-side rating with a target below spot, or the reverse.
    // 422, not 400: the body is well-formed, the research isn't. `detail` says which way it breaks.
    rating_contradicts_target: [422, 'The rating and the price target point in opposite directions'],
}

const crud = makeEntityController({
    log: LOG, noun: 'coverage', overrides: COVERAGE_REASONS,
    service: {
        // `?sector=` / `?status=` — the service validates them; a raw query param must never reach
        // Mongo as an operator. Named explicitly rather than spread: the options bag now also
        // carries `onError`, which decides whether a failed read degrades to [] or 500s, and that
        // is a caller's decision — not something a client gets to flip from the URL.
        list: (userId, req) => coverageService.getCoverage(userId, {
            sector: req.query?.sector ?? null,
            status: req.query?.status ?? null,
        }),
        get:  (id, userId)  => coverageService.getCoverageById(id, userId),
    },
})

export const listCoverage   = crud.list
export const getCoverageOne = crud.get

// ── The moves that aren't CRUD ────────────────────────────────────────────────
// Initiate and update each carry judgment a shared shell can't hold: initiation guards a once-per-name
// event, update takes a patch under an envelope.
//
// Retire and delete are DIFFERENT operations and now have different routes. Retire (POST …/retire) is
// a status change that keeps the document and its revision trail — archived research. Delete (DELETE
// …/:id) removes it for good. Retire used to wear the DELETE verb, which made the API say "removed"
// while the doc stayed; the verbs now mean what they say.

export async function initiateCoverage(req, res) {
    try {
        const { coverage } = req.body ?? {}
        if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
            return res.status(400).send({ error: 'coverage must be an object' })
        }
        const result = await coverageService.initiateCoverage(coverage, req.user._id)
        // The existing id rides along on `already_covered` so the caller can go straight to it —
        // coverageRefresh depends on that to update instead of giving up.
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
        const result = await coverageService.updateCoverage(req.params.id, patch, req.user._id)
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
        const result = await coverageService.retireCoverage(req.params.id, req.user._id)
        if (!result.ok) return sendReason(res, result.reason, { overrides: COVERAGE_REASONS, fallback: 500, fallbackMessage: 'Failed to retire coverage' })
        // Answers the updated document, not `{ok:true}` — the name is still in the book, retired.
        res.send(result.doc)
    } catch (err) {
        logger.error(LOG, 'retireCoverage failed', err)
        res.status(500).send({ error: 'Failed to retire coverage' })
    }
}

// Permanent — the document and its revision trail are gone. Answers `{ ok: true }` because there is
// no longer a document to answer with, which is exactly the difference from retire above.
export async function deleteCoverage(req, res) {
    try {
        const result = await coverageService.deleteCoverage(req.params.id, req.user._id)
        if (!result.ok) return sendReason(res, result.reason, { overrides: COVERAGE_REASONS, fallback: 500, fallbackMessage: 'Failed to delete coverage' })
        logger.info(LOG, 'coverage deleted', { id: req.params.id })
        res.send({ ok: true })
    } catch (err) {
        logger.error(LOG, 'deleteCoverage failed', err)
        res.status(500).send({ error: 'Failed to delete coverage' })
    }
}
