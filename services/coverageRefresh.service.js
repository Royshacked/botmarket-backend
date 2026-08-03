// Coverage refresh-by-hop (G1) — the ASYNC Atlas → Prometheus handoff. During a portfolio review Atlas
// may judge a held name's coverage stale and emit <coverage_refresh>; the controller fires this
// (route-and-return). It runs Prometheus (the Analyst agent) HEADLESS for that one name, persists the
// rewritten coverage (initiate a new thesis, or update the existing one — appending a revision), then
// pings the user to resume the review. The crossing stays artifact-mediated: Prometheus WRITES the
// coverage doc, Atlas RE-READS it on resume — no live agent-to-agent judgment injection.

import { analystAgentService } from './analyst.agent.service.js'
import { coverageService }     from '../api/analyst/coverage.service.js'
import { notifyCoverageRefreshed } from './coverageNotify.service.js'
import { withTimeout }         from './timeout.util.js'
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
    // The thesis being refreshed. Fetched so the agent runs in UPDATE mode (analyst.agent.service
    // `existing_coverage`) instead of from a blank slate — see _existingCoverage below.
    existing: (userId, symbol)     => _existingCoverage(userId, symbol),
}
export function _setDeps(d) { Object.assign(_deps, d) }

/** Why a persist failed, for the caller's log — the service's own reason when it gave one. */
const _reason = r => (typeof r === 'string' && r.trim() ? r.trim() : 'persist_failed')

/** The user's live thesis for this name, or null. Never throws — a refresh must survive a bad read. */
async function _existingCoverage(userId, symbol) {
    try {
        const rows = await coverageService.getCoverage(userId)
        return (Array.isArray(rows) ? rows : [])
            .find(c => String(c.symbol ?? '').toUpperCase() === symbol) ?? null
    } catch {
        return null
    }
}

// The headless research prompt. A refresh is a re-model of an EXISTING thesis, optionally focused by
// Atlas's question. Pure — exported for tests.
//
// The language line matters because this path has no conversation to inherit from. A thesis written
// in Spanish by an analyst working in Spanish would otherwise come back in English purely because
// the SCHEDULER spoke English — a doc silently changing language on its own, with no one asking.
export function _buildRefreshPrompt(ticker, question) {
    const q = typeof question === 'string' && question.trim() ? question.trim() : null
    return `Re-research ${ticker} and emit an updated <coverage> block for it.`
        + (q ? ` Focus especially on: ${q}` : '')
        + ` This is a refresh of an existing thesis for a portfolio review — produce your current variant-perception view, our price target vs the Street, catalysts, and monitorable kill-criteria.`
        + ` Write the block's prose in the SAME LANGUAGE as the existing coverage shown to you; keep the vocabulary fields (rating, status, band_basis, horizon) in canonical English.`
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
        // UPDATE MODE. Without this the agent researches from a blank slate every time and the prompt's
        // claim that it is "a refresh of an existing thesis" is a fiction — it was never shown one.
        // That mattered little when a refresh was an occasional Atlas request; now that the coverage
        // monitor schedules re-models off earnings dates, every one of them would discard the prior
        // view rather than revise against it, which is exactly what the revision trail exists to show.
        // It also carries the language of the existing thesis (see _buildRefreshPrompt).
        const existing = await deps.existing(userId, sym)

        const result = await withTimeout(deps.research({
            messages:  [],
            userPrompt: _buildRefreshPrompt(sym, question),
            ...(existing ? { chatState: { existing_coverage: existing, active_symbol: sym } } : {}),
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
        let coverageId = null, persisted = false, failReason = 'persist_failed'
        const init = await deps.initiate(draft, userId)
        if (init?.ok) {
            coverageId = init.doc?.id ?? null
            persisted  = true
        } else if (init?.reason === 'already_covered') {
            const upd = await deps.update(init.id, draft, userId)
            coverageId = init.id
            persisted  = Boolean(upd?.ok)
            if (!upd?.ok) { failReason = _reason(upd?.reason); logger.warn(LOG, 'coverage update returned not-ok', { id: init.id, reason: upd?.reason, detail: upd?.detail }) }
        } else {
            failReason = _reason(init?.reason)
            logger.warn(LOG, 'coverage persist failed', { ticker: sym, reason: init?.reason, detail: init?.detail })
        }

        // Nothing was written — say so. Telling the user "fresh research is ready" and sending them to
        // a thesis that never changed is worse than reporting the failure: the review resumes on the
        // OLD artifact either way, and only one of those messages is true.
        if (!persisted) {
            await deps.notify({ userId, ticker: sym, portfolioId, portfolioName, coverageId, ok: false })
            return { ok: false, reason: failReason }
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
