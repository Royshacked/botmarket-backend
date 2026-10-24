// THE WEEK'S RESEARCH, BY ITSELF — filter 2 of the house research chain (docs/design/house-research-chain.md
// steps 5-6; Roy, 2026-10-23: "promotheus automatically — lets stop asking admin to do it").
//
// After the house scan queues a week's names, Prometheus researches them as the HOUSE (the same run the admin's
// Start makes, researchRun.startRun, for those symbols only), inside a weekly research budget
// (HOUSE_RESEARCH_MAX_USD). The budget is the LAST SEVEN DAYS' research spend on Pythia's names, read from the queue
// rows themselves — every researched row carries its `cost_usd` (step 1) — so it survives a restart with no tally to
// lose, and means "a week" however many weeks contributed names.
//
// RESUME. The run lives in memory: a deploy mid-run leaves names `in_research` and nothing restarts it. Each tick of
// the weekly monitor calls `resumeWeeks` over the last RESUME_WEEKS finished weeks — so names a busy run, a spent
// budget or a dead process left behind are not orphaned when the next week finishes: their stale claims go back to
// `queued`, and a run starts over what is still queued, oldest first, with what is left of the budget. A run already
// going (a sleeve's, the admin's) → it waits for the next tick. Never throws: the callers are the weekly run and a
// monitor tick.

import { researchQueueService } from './researchQueue.service.js'
import { researchRunService } from './researchRun.service.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[houseResearch]'

/** A claim untouched this long is a dead run's: a research turn is ~2–5 minutes. */
export const STALE_CLAIM_MS = 30 * 60 * 1000
/** The finished weeks whose names the pick-up still researches. Older ones are the admin's to clear. */
export const RESUME_WEEKS = 4
/** The budget's window. */
export const BUDGET_WINDOW_MS = 7 * 86_400_000

const _deps = {
    listQueue: (q) => researchQueueService.listQueue(q),
    requeueStale: (o) => researchQueueService.requeueStale(o),
    startRun: (o) => researchRunService.startRun(o),
    getRun: () => researchRunService.getRun(),
    maxUsd: () => config.houseResearchMaxUsd,
}
export function _setDeps(d) { Object.assign(_deps, d) }

/** The symbols the weeks' house scans queued, oldest week first. Pure. */
export function weekSymbols(weeks) {
    const list = (Array.isArray(weeks) ? weeks : [weeks]).filter(Boolean)
    const ordered = [...list].sort((a, b) => String(a.asof ?? '').localeCompare(String(b.asof ?? '')))
    return [...new Set(ordered.flatMap(w => (w.house_scan?.queued ?? []).map(q => String(q.symbol).toUpperCase())))]
}

/** The earliest start among the weeks — the names were queued after it. Pure. */
const _since = (weeks) => weeks.map(w => w.started_at).filter(Boolean).sort()[0] ?? null

/**
 * Research the weeks' names → `{ ok, outcome, ... }`, outcome one of started | nothing_queued | budget_spent | busy |
 * no_names | queue_unavailable | error. `weeks` is one pythia_weekly document after its house scan, or several.
 */
export async function researchWeeks(weeks, deps = _deps, { now = Date.now() } = {}) {
    const list = (Array.isArray(weeks) ? weeks : [weeks]).filter(Boolean)
    // The budget is ALL of the last seven days' research on Pythia's names, whichever week sent them — read on its own,
    // or the week that just finished would not see what the pick-up spent on older weeks two days ago (code review
    // 2026-10-23).
    // The arguments are worked out inside the try: a bad `now` returns an error outcome, as it did before the pipe was
    // shared, instead of throwing into the weekly run (code review 2026-10-24).
    let args
    try {
        args = { symbols: weekSymbols(list), since: _since(list), source: 'pythia', maxUsd: deps.maxUsd(),
            budgetSince: new Date(now - BUDGET_WINDOW_MS).toISOString() }
    } catch (err) {
        logger.warn(LOG, 'research not started', { error: err.message })
        return { ok: false, outcome: 'error', detail: err.message }
    }
    return researchQueued(args, deps)
}

/**
 * THE PIPE both automatic chains share (horizon-chains.md §4 — the Pythia week's and the Hotlist's day): research the
 * given names that are still `queued` from `source`, as the house, inside what is left of a budget — `maxUsd` less
 * everything researched from `source` since `budgetSince` (read back from the rows' `cost_usd`). Names in `symbols`'
 * order. → `{ ok, outcome, ... }`, outcome one of started | nothing_queued | budget_spent | busy | no_names |
 * queue_unavailable | error. Each chain owns its own names, budget and window; this owns the mechanism. `spentBy` — which
 * of the source's recent rows count against the budget (the Hotlist: its own day's, the house's only); default all.
 * `maxUsd` Infinity: no budget (a read the user asked for, capped by count where it was queued).
 */
export async function researchQueued({ symbols, since = null, source, maxUsd, budgetSince, spentBy = null }, deps = _deps) {
    try {
        if (!symbols?.length) return { ok: true, outcome: 'no_names' }
        const rows = await deps.listQueue({ symbols, since, limit: 500 })
        const recent = await deps.listQueue({ source, updatedSince: budgetSince, limit: 1000 })
        if (rows === null || recent === null) return { ok: false, outcome: 'queue_unavailable' }
        const own = rows.filter(r => r.source === source)
        const spent = (spentBy ? recent.filter(spentBy) : recent).reduce((s, r) => s + (Number(r.cost_usd) || 0), 0)
        const left = Math.max(0, (Number(maxUsd) || 0) - spent)
        const order = new Map(symbols.map((s, i) => [s, i]))
        const waiting = own.filter(r => r.status === 'queued').map(r => r.symbol).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
        if (!waiting.length) return { ok: true, outcome: 'nothing_queued', spent_usd: spent }
        if (left <= 0) {
            logger.info(LOG, `the ${source} research budget is spent — names wait`, { waiting: waiting.length, spent_usd: spent })
            return { ok: true, outcome: 'budget_spent', waiting: waiting.length, spent_usd: spent }
        }
        const res = await deps.startRun({ userId: null, symbols: waiting, maxUsd: Number.isFinite(left) ? left : null, source })
        if (!res?.ok) {
            const outcome = res?.reason === 'already_running' ? 'busy' : (res?.reason ?? 'error')
            logger.info(LOG, `research not started: ${outcome}`, { waiting: waiting.length })
            return { ok: outcome === 'busy' || outcome === 'nothing_queued', outcome, waiting: waiting.length }
        }
        logger.info(LOG, 'research started', { source, names: waiting.length, budget_usd: Number.isFinite(left) ? Number(left.toFixed(4)) : null, run: res.run?.id })
        return { ok: true, outcome: 'started', names: waiting.length, budget_usd: left, run: res.run?.id ?? null }
    } catch (err) {
        logger.warn(LOG, 'research not started', { error: err.message })
        return { ok: false, outcome: 'error', detail: err.message }
    }
}

/** One week, right after its house scan. */
export const researchWeek = (week, deps = _deps, opts) => researchWeeks([week], deps, opts)

/**
 * The tick's pick-up over the recent finished weeks: their dead claims back in line, then research what waits. A run
 * going → nothing is touched (its claim is live).
 */
export async function resumeWeeks(weeks, deps = _deps, { now = Date.now() } = {}) {
    const list = (Array.isArray(weeks) ? weeks : [weeks]).filter(Boolean)
    return resumeQueued(weekSymbols(list), () => researchWeeks(list, deps, { now }), deps, { now, source: 'pythia' })
}

/**
 * The pick-up both chains share: names a dead run left claimed go back in line, then `research()` runs what waits. A
 * run going → nothing is touched (its claim is live). `source` is the chain asking: an admin's STOP on another chain's
 * run does not halt this one (code review 2026-10-24); a stopped Start-all (no source) halts both.
 */
export async function resumeQueued(symbols, research, deps = _deps, { now = Date.now(), source = null } = {}) {
    if (!symbols?.length) return { ok: true, outcome: 'no_names' }
    const last = deps.getRun()
    if (last?.status === 'running') return { ok: true, outcome: 'busy' }
    // The admin pressed STOP: the pick-up does not start it again behind their back. The next Start, or the next
    // week's own research, is what resumes (code review 2026-10-23). In memory, like the run: a restart forgets it,
    // but the stopped claim keeps its `stopped` reason, so that name still waits for the admin.
    if (last?.status === 'stopped' && (!last.source || !source || last.source === source)) return { ok: true, outcome: 'stopped_by_admin' }
    await Promise.resolve(deps.requeueStale({ symbols, olderThanMs: STALE_CLAIM_MS, now })).catch(() => null)
    return research()
}

export const houseResearchService = { researchWeek, researchWeeks, resumeWeeks, researchQueued, resumeQueued }
