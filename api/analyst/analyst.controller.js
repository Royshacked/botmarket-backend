// HTTP handlers for Analyst coverage (P1 = the coverage CRUD; the streaming agent lands in P3).
import { coverageService } from './coverage.service.js'
import { logger }          from '../../services/logger.service.js'

const LOG = '[analystCtrl]'

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
