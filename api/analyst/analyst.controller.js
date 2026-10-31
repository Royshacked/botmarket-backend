// HTTP handlers for the Analyst: coverage CRUD (P1) + the research queue (Argus→Prometheus admin pipeline). The research
// conversation itself is a session turn (services/desks/analyst.desk.js) — its HTTP stream went in unified-chat 8e.
import { sealing } from '../../services/desks/seal.js'
import { forgetIfDeleted } from '../../services/agentContext.service.js'
import { coverageService } from './coverage.service.js'
import { coverageCommit } from './coverageCommit.service.js'
import { COVERAGE_REASONS } from './coverageReasons.js'
import { resolveCardsFor }        from '../chat/chat.service.js'
import { sendReason }             from '../_shared/reason.util.js'
import { makeHandle }             from '../_shared/handle.util.js'
import { httpError }              from '../../services/httpError.util.js'
import { logger }                 from '../../services/logger.service.js'

const LOG = '[analystCtrl]'
// Every handler here rides makeHandle. The queue and run handlers moved first (§6): they had no
// try/catch at all and were one thrown read away from a hung request (Express 4 does not see an
// async rejection). The coverage handlers followed in §9, once the global handler stopped shipping
// a 500's message in production — until then their fixed slugs were the only thing keeping a Mongo
// sentence out of a toast.
const _handle = makeHandle(LOG)

// ─── Coverage CRUD ────────────────────────────────────────────────────────────

export const listCoverage = _handle('listCoverage', async (req, res) => {
    res.send(await coverageService.getCoverage({
        sector: req.query?.sector ?? null,
        status: req.query?.status ?? null,
    }))
})

export const getCoverageOne = _handle('getCoverageOne', async (req, res) => {
    const result = await coverageService.getCoverageById(req.params.id)
    if (!result.ok) return sendReason(res, result.reason, { overrides: COVERAGE_REASONS, fallback: 404, fallbackMessage: 'Not found' })
    res.send(result.doc)
})

export const getCoverageBySymbol = _handle('getCoverageBySymbol', async (req, res) => {
    const doc = await coverageService.getCoverageBySymbol(req.params.symbol)
    if (!doc) throw httpError(404, 'Coverage not found')
    res.send(doc)
})

export const initiateCoverage = _handle('initiateCoverage', async (req, res) => {
    const { coverage } = req.body ?? {}
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) throw httpError(400, 'coverage must be an object')
    const result = await coverageService.initiateCoverage(coverage)
    if (!result.ok) {
        return sendReason(res, result.reason, {
            overrides: COVERAGE_REASONS, fallback: 500, fallbackMessage: 'Failed to initiate coverage',
            extra: { ...(result.id ? { id: result.id } : {}), ...(result.detail ? { detail: result.detail } : {}) },
        })
    }
    // With a sessionId, Prometheus's turns move onto the coverage they produced — per user, even on house
    // coverage (agentContext.service). Never fails the write.
    sealing.sealAfterGenerate(req, { kind: 'coverage', entityIds: [result.doc?.id], name: result.doc?.symbol ?? null })
    res.send(result.doc)
})

export const updateCoverage = _handle('updateCoverage', async (req, res) => {
    const patch = req.body?.patch ?? req.body
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw httpError(400, 'patch must be an object')
    // The revision and the cards it satisfies — one service with Prometheus's session action (coverageCommit).
    const result = await coverageCommit.revise(req.params.id, patch)
    if (!result.ok) return sendReason(res, result.reason, {
        overrides: COVERAGE_REASONS, fallback: 500, fallbackMessage: 'Failed to update coverage',
        extra: result.detail ? { detail: result.detail } : null,
    })
    sealing.sealAfterGenerate(req, { kind: 'coverage', entityIds: [req.params.id], name: result.doc?.symbol ?? null, onlyIfEditing: true })
    res.send(result.doc)
})

export const retireCoverage = _handle('retireCoverage', async (req, res) => {
    const result = await coverageService.retireCoverage(req.params.id)
    if (!result.ok) return sendReason(res, result.reason, { overrides: COVERAGE_REASONS, fallback: 500, fallbackMessage: 'Failed to retire coverage' })
    // Retiring answers the ask too: there is no thesis left to revise.
    await resolveCardsFor({ kind: 'coverage', id: req.params.id }, { outcome: 'retired', note: 'Coverage retired' })
    res.send(result.doc)
})

export const deleteCoverage = _handle('deleteCoverage', async (req, res) => {
    const result = await coverageService.deleteCoverage(req.params.id)
    if (!result.ok) return sendReason(res, result.reason, { overrides: COVERAGE_REASONS, fallback: 500, fallbackMessage: 'Failed to delete coverage' })
    logger.info(LOG, 'coverage deleted', { id: req.params.id })
    forgetIfDeleted('coverage', req.params.id, result)
    // A card asking to revise a thesis that no longer exists is a dead ask — close it as such.
    await resolveCardsFor({ kind: 'coverage', id: req.params.id }, { outcome: 'deleted', note: 'Coverage deleted' })
    res.send({ ok: true })
})

