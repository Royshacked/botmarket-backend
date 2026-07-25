// Coverage refresh-by-hop (G1) — the ASYNC Atlas → Prometheus handoff. During a portfolio review Atlas
// may judge a held name's coverage stale and emit <coverage_refresh>; the controller fires this
// (route-and-return). It runs Prometheus (the Analyst agent) HEADLESS for that one name, persists the
// rewritten coverage (initiate a new thesis, or update the existing one — appending a revision), then
// pings the user to resume the review. The crossing stays artifact-mediated: Prometheus WRITES the
// coverage doc, Atlas RE-READS it on resume — no live agent-to-agent judgment injection.

import { analystAgentService } from './analyst.agent.service.js'
import { coverageService }     from '../api/analyst/coverage.service.js'
import { notifyCoverageRefreshed } from './coverageNotify.service.js'
import { withTimeout }         from '../monitoring/monitorUtils.js'
import { logger }              from './logger.service.js'

const LOG = '[coverageRefresh]'
// Deep re-research is multi-phase + tool-heavy; bound it so a hung run can't leak a pending job forever.
const RESEARCH_TIMEOUT_MS = 3 * 60 * 1000

// Injectable IO so tests exercise the branching (draft/no-draft, initiate/update, notify) without a
// real LLM run or DB writes.
const _deps = {
    research: (args)               => analystAgentService.chatStream(args),
    initiate: (draft, userId)      => coverageService.initiateCoverage(draft, userId),
    update:   (id, patch, userId)  => coverageService.updateCoverage(id, patch, userId),
    notify:   (args)               => notifyCoverageRefreshed(args),
}
export function _setDeps(d) { Object.assign(_deps, d) }

// The headless research prompt. A refresh is a re-model of an EXISTING thesis, optionally focused by
// Atlas's question. Pure — exported for tests.
export function _buildRefreshPrompt(ticker, question) {
    const q = typeof question === 'string' && question.trim() ? question.trim() : null
    return `Re-research ${ticker} and emit an updated <coverage> block for it.`
        + (q ? ` Focus especially on: ${q}` : '')
        + ` This is a refresh of an existing thesis for a portfolio review — produce your current variant-perception view, our price target vs the Street, catalysts, and monitorable kill-criteria.`
}

/**
 * Run one async coverage refresh for a held name and ping the user when done. Fire-and-forget from the
 * review controller — NEVER throws (best-effort end to end). Returns a small outcome for tests/logs.
 *
 * @param {{ userId:string, ticker:string, question?:string|null, portfolioId?:string|null, portfolioName?:string|null }} args
 */
export async function refreshCoverage({ userId, ticker, question = null, portfolioId = null, portfolioName = null }, deps = _deps) {
    const sym = String(ticker ?? '').toUpperCase().trim()
    if (!userId || !sym) return { ok: false, reason: 'bad_args' }

    logger.info(LOG, 'refresh start', { userId, ticker: sym, portfolioId })
    try {
        const result = await withTimeout(deps.research({
            messages:  [],
            userPrompt: _buildRefreshPrompt(sym, question),
            userId,
            onToken: () => {}, onToolStart: () => {}, onReasoning: () => {}, onPhase: () => {},
        }), RESEARCH_TIMEOUT_MS)

        const draft = result?.coverage
        // A "no-edge" turn (or a wrong-symbol draft) yields nothing to persist — tell the user we left
        // the existing coverage in place so the review can still resume.
        if (!draft || String(draft.symbol ?? '').toUpperCase().trim() !== sym) {
            logger.warn(LOG, 'no usable coverage draft', { ticker: sym })
            await deps.notify({ userId, ticker: sym, portfolioId, portfolioName, ok: false })
            return { ok: false, reason: 'no_draft' }
        }

        // Persist: initiate a fresh thesis, or update the existing one (appends a revision). initiate
        // returns already_covered + the id when a thesis already exists for (user, symbol).
        let coverageId = null
        const init = await deps.initiate(draft, userId)
        if (init?.ok) {
            coverageId = init.coverage?.id ?? null
        } else if (init?.reason === 'already_covered') {
            const upd = await deps.update(init.id, draft, userId)
            coverageId = init.id
            if (!upd?.ok) logger.warn(LOG, 'coverage update returned not-ok', { id: init.id })
        } else {
            logger.warn(LOG, 'coverage persist failed', { ticker: sym, reason: init?.reason })
        }

        await deps.notify({ userId, ticker: sym, portfolioId, portfolioName, coverageId, summary: draft.thesis ?? null, ok: true })
        logger.info(LOG, 'refresh done', { ticker: sym, coverageId })
        return { ok: true, coverageId }
    } catch (err) {
        logger.warn(LOG, 'refresh failed', err.message)
        // Best-effort ping so the user isn't left waiting on a silent failure.
        try { await deps.notify({ userId, ticker: sym, portfolioId, portfolioName, ok: false }) } catch { /* ignore */ }
        return { ok: false, reason: 'error' }
    }
}
