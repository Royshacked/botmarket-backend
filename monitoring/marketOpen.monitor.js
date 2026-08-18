/**
 * The market-open sweep — the ONE drain for everything that parked while a venue was shut.
 *
 * WHAT PARKS. Two stores, deliberately kept apart (pendingWork.service.js explains why the union is
 * a read and not a migration):
 *   • ENTITIES at `orderState: 'awaiting_market'` — an entry whose plan was built but not placed.
 *     Written by `_attachImmediatePlan` (the immediate ticket AND a portfolio add), `triggerEntryNow`
 *     ("Buy now"), and Talos when a setup's zone trips off-hours.
 *   • QUEUED ACTIONS (`pending_actions`) — a trim, exit or scale-in the user confirmed off-hours.
 *     These own no entity; the record IS the intent. Added 2026-08-07 with the rule that nothing
 *     executes off-hours, paper included.
 *
 * WHY IT IS ITS OWN MONITOR. The sweep used to live inside the `idea` kind's monitor. When that
 * monitor was switched off (and later deleted outright) the sweep went with it, and every deferred
 * order in the app silently stopped waking up — parked forever, invisible, because the frontend
 * deliberately hides `awaiting_market`. The state is written by three kinds but was drained by one
 * kind's monitor; that mismatch is the bug. So this loop owns exactly one thing, is kind-BLIND, and
 * has no reason to be switched off with any agent.
 *
 * WHAT IT DOES NOT DO. It does not place anything, and never has. It makes the work executable and
 * tells the user — the same confirm they would have got had the market been open. Placement stays
 * behind an authenticated POST.
 *
 * ONE CARD, FROM AXL. It used to fan out a card per desk per kind: a batch from Atlas and another
 * from Mentor in the same second, each answering "what does this desk have for you" — a question
 * nobody asks. At the open the question is "what is waiting on ME". It has one answer, so it gets
 * one nudge pointing at one list. The card is Axl's because the QUEUE is Axl's, and it stays a
 * POINTER: a count and a route, never a summary of another desk's judgment (project_axl_agent).
 *
 * STALENESS. A plan built Friday afternoon is confirmed against Monday's open. We surface it as-is
 * with its AGE attached rather than rebuilding or expiring it: the plan is what the desk authored,
 * and whether it still stands is the user's call, not a monitor's.
 */

import { logger } from '../services/logger.service.js'
import { isAssetOpen } from '../services/market.service.js'
import { entityRepo } from '../services/entity/entityRepo.service.js'
import { createPollLoop } from './pollLoop.js'
import { notifyQueueReady } from '../services/tradeNotify.service.js'
import { listQueued, transition, STATES } from '../services/pendingAction/pendingAction.repo.js'
import { countReady } from '../services/pendingAction/pendingWork.service.js'

const LOG = '[marketOpen.monitor]'

const POLL_INTERVAL_MS = 60_000

/** Hours since a decision was taken, from whichever stamp its source carries. */
function _ageHours(item, nowMs) {
    const at = item?.pendingOrder?.builtAt ?? item?.decidedAt
    if (!Number.isFinite(at)) return null
    return Math.max(0, (nowMs - at) / 3_600_000)
}

/**
 * Group key: one card per USER. This used to be per user PER KIND, which is exactly what produced
 * two cards in the same second for one market open.
 */
function _groupKey(item) {
    return String(item?.userId ?? '')
}

/**
 * The collaborators, injectable — the same shape Hermes and Talos use, so the sweep can be
 * exercised against fixed data and a fixed clock without a Mongo or a chat server.
 */
const _DEFAULT_DEPS = {
    list:       () => entityRepo.listByOrderState('awaiting_market'),
    claim:      (id) => entityRepo.claimIf(id, { orderState: 'awaiting_market' }, { orderState: 'awaiting_confirm' }),
    listQueued: () => listQueued(),
    // `from: QUEUED` is what makes the release exactly-once. Without it an already-released row
    // would move again, so two overlapping ticks would each think they woke it and each post a card.
    release:    (rec) => transition(rec.id, rec.userId, STATES.RELEASED, { releasedAt: Date.now() }, { from: STATES.QUEUED }),
    isAssetOpen,
    onReady:    (summary) => notifyQueueReady(summary),
    countReady,
    now:        () => Date.now(),
}

/**
 * Unpark the entities whose venue just opened.
 *
 * CLAIM FIRST, CARD SECOND. The claim is what makes the nudge exactly-once: `claimIf` only succeeds
 * for the caller that actually moved the entity off 'awaiting_market', so an overlapping tick (or a
 * second process) claims nothing and therefore says nothing.
 */
async function _drainEntities(d) {
    let parked
    try {
        parked = await d.list()
    } catch (err) {
        logger.error(LOG, 'market sweep read error:', err.message)
        return []
    }
    const surface = (parked ?? []).filter(e => d.isAssetOpen(e?.asset, e?.asset_class))
    if (!surface.length) return []

    const claimed = []
    for (const entity of surface) {
        try {
            if (await d.claim(entity.id)) claimed.push(entity)
        } catch (err) {
            logger.error(LOG, `[${entity?.id}] claim failed:`, err.message)
        }
    }
    return claimed
}

/**
 * Release the queued actions whose venue just opened. Same exactly-once shape as the entity claim:
 * `transition` only moves a record that is still open, so a racing tick releases nothing.
 */
async function _drainQueue(d) {
    let queued
    try {
        queued = await d.listQueued()
    } catch (err) {
        logger.error(LOG, 'queue read error:', err.message)
        return []
    }
    const surface = (queued ?? []).filter(r => d.isAssetOpen(r?.asset, r?.assetClass))
    if (!surface.length) return []

    const released = []
    for (const rec of surface) {
        try {
            if (await d.release(rec)) released.push(rec)
        } catch (err) {
            logger.error(LOG, `[${rec?.id}] release failed:`, err.message)
        }
    }
    return released
}

async function _tick(deps = _DEFAULT_DEPS) {
    const d     = { ..._DEFAULT_DEPS, ...deps }
    const nowMs = d.now()

    // Both drains complete before anything is said, so the card counts the whole open rather than
    // whichever source happened to be read first.
    const [entities, released] = await Promise.all([_drainEntities(d), _drainQueue(d)])
    const woken = [...entities, ...released]
    if (!woken.length) return

    const groups = new Map()
    for (const item of woken) {
        const key = _groupKey(item)
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(item)
    }

    logger.info(LOG, `market open: woke ${entities.length} parked order(s) + ${released.length} queued action(s) for ${groups.size} user(s)`)

    for (const [userId, items] of groups) {
        try {
            // The count is EVERYTHING waiting on them, not only this tick's wake-ups: the list they
            // are about to open shows the lot, and a card that says 2 above a list of 5 reads as a
            // bug. Falls back to this tick's count if that read fails — never block the nudge.
            const total  = (await d.countReady(userId)) || items.length
            const ages   = items.map(i => _ageHours(i, nowMs)).filter(v => v != null)
            const assets = [...new Set(items.map(i => i?.asset).filter(Boolean))]
            await d.onReady({
                userId,
                count:      total,
                assets,
                staleHours: ages.length ? Math.max(...ages) : null,
            })
        } catch (err) {
            // The work is already executable and visible in the list; a failed card must not undo
            // that, or abort the remaining users.
            logger.warn(LOG, `queue-ready card failed for ${userId}:`, err.message)
        }
    }
}

const _loop = createPollLoop({
    intervalMs: POLL_INTERVAL_MS, tick: _tick, eager: true, log: LOG, name: 'market-open sweep',
})

export const marketOpenMonitor = { start: _loop.start, stop: _loop.stop }

// Test seams — the tick, the two drains and the pure helpers, so the sweep can be exercised
// without a clock or a DB.
export { _tick, _ageHours, _groupKey, _drainEntities, _drainQueue }
