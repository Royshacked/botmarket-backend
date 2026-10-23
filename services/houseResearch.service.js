// THE WEEK'S RESEARCH, BY ITSELF — filter 2 of the house research chain (docs/design/house-research-chain.md
// steps 5-6; Roy, 2026-10-23: "promotheus automatically — lets stop asking admin to do it").
//
// After the house scan queues a week's names, Prometheus researches them as the HOUSE (the same run the admin's
// Start makes, researchRun.startRun, for those symbols only), inside the week's research budget
// (HOUSE_RESEARCH_MAX_USD). The budget is read from the queue rows themselves — every researched row carries its
// `cost_usd` (step 1) — so it survives a restart with no tally to lose.
//
// RESUME. The run lives in memory: a deploy mid-run leaves names `in_research` and nothing restarts it. Each tick of
// the weekly monitor calls `resumeWeek`: the week's stale claims go back to `queued`, and a run starts over what is
// still queued, with what is left of the budget. A run already going (a sleeve's, the admin's) → the week waits for
// the next tick. Never throws: the callers are the weekly run and a monitor tick.

import { researchQueueService } from './researchQueue.service.js'
import { researchRunService } from './researchRun.service.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[houseResearch]'

/** A claim untouched this long is a dead run's: a research turn is ~2–5 minutes. */
export const STALE_CLAIM_MS = 30 * 60 * 1000

const _deps = {
    listQueue: (q) => researchQueueService.listQueue(q),
    requeueStale: (o) => researchQueueService.requeueStale(o),
    startRun: (o) => researchRunService.startRun(o),
    getRun: () => researchRunService.getRun(),
    maxUsd: () => config.houseResearchMaxUsd,
}
export function _setDeps(d) { Object.assign(_deps, d) }

/** The symbols a week's house scan queued. Pure. */
export function weekSymbols(week) {
    return [...new Set((week?.house_scan?.queued ?? []).map(q => String(q.symbol).toUpperCase()))]
}

/**
 * Research a week's names → `{ ok, outcome, ... }`, outcome one of started | nothing_queued | budget_spent | busy |
 * no_names | queue_unavailable | error. `week` is the pythia_weekly document after its house scan.
 */
export async function researchWeek(week, deps = _deps) {
    try {
        const symbols = weekSymbols(week)
        if (!symbols.length) return { ok: true, outcome: 'no_names' }
        const since = week.started_at ?? null
        const rows = await deps.listQueue({ symbols, since, limit: 500 })
        if (rows === null) return { ok: false, outcome: 'queue_unavailable' }
        const pythia = rows.filter(r => r.source === 'pythia')
        const spent = pythia.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0)
        const left = Math.max(0, (Number(deps.maxUsd()) || 0) - spent)
        const waiting = pythia.filter(r => r.status === 'queued').map(r => r.symbol)
        if (!waiting.length) return { ok: true, outcome: 'nothing_queued', spent_usd: spent }
        if (left <= 0) {
            logger.info(LOG, 'the week\'s research budget is spent — names wait', { asof: week.asof, waiting: waiting.length, spent_usd: spent })
            return { ok: true, outcome: 'budget_spent', waiting: waiting.length, spent_usd: spent }
        }
        const res = await deps.startRun({ userId: null, symbols: waiting, maxUsd: left })
        if (!res?.ok) {
            const outcome = res?.reason === 'already_running' ? 'busy' : (res?.reason ?? 'error')
            logger.info(LOG, `research not started: ${outcome}`, { asof: week.asof, waiting: waiting.length })
            return { ok: outcome === 'busy' || outcome === 'nothing_queued', outcome, waiting: waiting.length }
        }
        logger.info(LOG, 'research started', { asof: week.asof, names: waiting.length, budget_usd: Number(left.toFixed(4)), run: res.run?.id })
        return { ok: true, outcome: 'started', names: waiting.length, budget_usd: left, run: res.run?.id ?? null }
    } catch (err) {
        logger.warn(LOG, 'research not started', { error: err.message })
        return { ok: false, outcome: 'error', detail: err.message }
    }
}

/**
 * The tick's pick-up: put the week's dead claims back in line, then research what waits. A run going → nothing is
 * touched (its claim is live).
 */
export async function resumeWeek(week, deps = _deps, { now = Date.now() } = {}) {
    const symbols = weekSymbols(week)
    if (!symbols.length) return { ok: true, outcome: 'no_names' }
    if (deps.getRun()?.status === 'running') return { ok: true, outcome: 'busy' }
    await Promise.resolve(deps.requeueStale({ symbols, olderThanMs: STALE_CLAIM_MS, now })).catch(() => null)
    return researchWeek(week, deps)
}

export const houseResearchService = { researchWeek, resumeWeek }
