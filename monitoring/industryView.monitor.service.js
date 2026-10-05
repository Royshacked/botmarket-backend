// The industry-view monitor — keeps Pythia's 163 answers current (docs/design/pythia-industry-questions.md §6).
//
// TWO LOOPS, because they cost different things:
//
//   • SYNC (every 6 hours, free — Mongo only). Seeds a `pending` view for every sub-industry the engine
//     measured, and brings a view forward when the engine's numbers raised a NEW early-review trigger
//     (revenue down two quarters, returns below the hurdle, margins at a range edge) — unless it was
//     reviewed within the last TRIGGER_COOLDOWN_DAYS, so one noisy quarter cannot re-review weekly.
//
//   • REVIEW (hourly, expensive). Every due view — pending, scheduled (yearly; quarterly for a cyclical
//     industry) or brought forward — gets a headless Pythia review, at most MAX_REVIEWS_PER_TICK an hour
//     so the first pass over 163 industries is a slow trickle, not a burst. Opt-in (INDUSTRY_REVIEWS):
//     off, nothing is spent and the due views simply wait.

import { createDueLoop } from './dueLoop.js'
import { createPollLoop } from './pollLoop.js'
import { industryViewService, COLLECTION } from '../api/strategy/industryView.service.js'
import { listSubIndustries } from '../api/strategy/industryData.service.js'
import { reviewIndustry, REVIEW_TIMEOUT_MS } from '../services/industryReview.service.js'
import { config } from '../services/config.js'
import { logger } from '../services/logger.service.js'

const LOG = '[industryMonitor]'
const SYNC_INTERVAL_MS   = 6 * 60 * 60 * 1000
const REVIEW_INTERVAL_MS = 60 * 60 * 1000
export const MAX_REVIEWS_PER_TICK = 3
export const TRIGGER_COOLDOWN_DAYS = 30

const _deps = {
    measured: () => listSubIndustries(),
    views:    () => industryViewService.listViews(),
    seed:     (subs) => industryViewService.seedMissing(subs),
    markDue:  (code, triggers) => industryViewService.markDue(code, triggers),
    review:   (code, reason) => reviewIndustry(code, reason),
    enabled:  () => config.industryReviews,
}
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * Which views a trigger should bring forward. Pure → [{ code, triggers }].
 * A trigger counts when it is NEW since the view's last review, and the view was not reviewed in the
 * cooldown. A pending view is due already and needs no help.
 */
export function _triggered(measured, views, nowMs = Date.now()) {
    const byCode = new Map(views.map(v => [v.code, v]))
    const out = []
    for (const m of measured) {
        const v = byCode.get(m.code)
        if (!v || v.status !== 'answered' || !m.triggers?.length) continue
        const seen = new Set(v.monitor?.last_triggers ?? [])
        const fresh = m.triggers.filter(t => !seen.has(t))
        if (!fresh.length) continue
        const last = Date.parse(v.monitor?.last_checked ?? '')
        if (Number.isFinite(last) && nowMs - last < TRIGGER_COOLDOWN_DAYS * 86_400_000) continue
        out.push({ code: m.code, triggers: m.triggers })
    }
    return out
}

/** One sync pass: seed missing views, bring triggered ones forward. Never throws. */
export async function _sync(deps = _deps) {
    try {
        const measured = await deps.measured()
        if (!measured.length) return { seeded: 0, triggered: 0 }
        const seeded = await deps.seed(measured)
        const due = _triggered(measured, await deps.views())
        for (const d of due) await deps.markDue(d.code, d.triggers)
        if (due.length) logger.info(LOG, 'brought forward by triggers', { codes: due.map(d => d.code) })
        return { seeded, triggered: due.length }
    } catch (err) {
        logger.warn(LOG, 'sync failed', err.message)
        return { seeded: 0, triggered: 0 }
    }
}

/** Why a due view is being reviewed, for the desk. Pure. */
export function _reason(view) {
    if (view.status === 'pending') return 'first answer for this sub-industry'
    if (view.monitor?.early_reason) return `early-review trigger: ${view.monitor.early_reason}`
    return 'scheduled review'
}

const _syncLoop = createPollLoop({ intervalMs: SYNC_INTERVAL_MS, tick: () => _sync(), eager: true, log: LOG, name: 'industry sync' })

const _reviewLoop = createDueLoop({
    collection: COLLECTION,
    statePath: 'monitor',
    // Pending first: an unanswered industry matters more than a scheduled re-look. The due query itself
    // has no order, so the cap is applied to what it returns — overflow stays due for the next tick.
    limit: MAX_REVIEWS_PER_TICK,
    // The lease covers a whole review; a shorter one would let the next tick re-claim a review still running.
    checkTimeoutMs: REVIEW_TIMEOUT_MS + 60_000,
    intervalMs: REVIEW_INTERVAL_MS,
    eager: false,
    log: LOG, name: 'industry review',
    check: async (view) => {
        if (!_deps.enabled()) {
            // Off: hand the claim back so the view stays due, and spend nothing.
            await industryViewService.recordMonitorState(view.id, { set: { 'monitor.next_check_at': view.monitor?.next_check_at ?? null } })
            return undefined
        }
        return _deps.review(view.code, _reason(view))
    },
})

export const industryViewMonitorService = {
    start: () => { _syncLoop.start(); _reviewLoop.start() },
    stop:  async () => { await Promise.all([_syncLoop.stop(), _reviewLoop.stop()]) },
}
