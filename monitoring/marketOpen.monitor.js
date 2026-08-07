/**
 * The market-open sweep — the drain for `awaiting_market`.
 *
 * WHAT PARKS HERE. When an entry fires (or a user sends an order from the ticket / a portfolio add)
 * while that asset's market is shut, the order plan is built but NOT placed: the entity is stamped
 * `orderState: 'awaiting_market'` and nothing is shown. Three paths write that state —
 * `_attachImmediatePlan` (the immediate ticket AND a portfolio add), `triggerEntryNow` ("Buy now"),
 * and Talos when a setup's zone trips off-hours.
 *
 * WHY IT IS ITS OWN MONITOR. The sweep used to live inside Minos, the monitor for the `idea` kind.
 * When Minos was archived (superseded by Hermes/Talos) the sweep went with it, and every deferred
 * order in the app silently stopped waking up — parked forever, invisible, because the frontend
 * deliberately hides `awaiting_market`. The state is written by three kinds but was drained by one
 * kind's monitor; that mismatch is the bug. So this loop owns exactly one thing, is kind-BLIND, and
 * has no reason to be switched off with any agent.
 *
 * WHAT IT DOES NOT DO. It does not place anything. It moves the order to `awaiting_confirm` and
 * tells the user — the same confirm the user would have got had the market been open. Placement
 * stays behind the OrderConfirmDialog and its authenticated POST, exactly as before.
 *
 * STALENESS. A plan built Friday afternoon is confirmed against Monday's open. We surface it as-is
 * with its AGE attached (card + dialog) rather than rebuilding or expiring it: the plan is what the
 * desk authored, and whether it still stands is the user's call, not a monitor's. See
 * buildOrdersReady / the `builtAt` line in OrderConfirmDialog.
 */

import { logger } from '../services/logger.service.js'
import { isAssetOpen } from '../services/market.service.js'
import { entityRepo } from '../services/entity/entityRepo.service.js'
import { entryTimeGate } from '../services/entryTimeGate.util.js'
import { createPollLoop } from './pollLoop.js'
import {
    notifyIdeaEntryConfirm, notifySetupEntryConfirm, notifyOrdersReady,
} from '../services/tradeNotify.service.js'

const LOG = '[marketOpen.monitor]'

const POLL_INTERVAL_MS = 60_000
// Below this, a batch is same-session and its age is not worth saying. Above it, the plan was
// priced before a close the user slept through.
const STALE_HOURS = 12

/**
 * Which desk owns a kind's confirm card. The BATCH card is grouped by this, so a portfolio's nine
 * legs arrive as one card from the idea bot and a setup arrives from Mentor — the notification
 * still belongs to the desk that authored the order, never to a cross-kind router
 * (project_axl_agent: each agent owns its notifications).
 *
 * Legacy documents predate the `kind` field and read as 'idea', matching entityRepo elsewhere.
 */
const KIND_ROUTING = {
    idea:           { botId: 'idea',   single: (e) => notifyIdeaEntryConfirm(e, _noteFor(e)) },
    portfolio_item: { botId: 'idea',   single: (e) => notifyIdeaEntryConfirm(e, _noteFor(e)) },
    setup:          { botId: 'mentor', single: (e) => notifySetupEntryConfirm(e, null) },
}

/**
 * WHY the order surfaced late, for the single-order card's copy.
 *   'off_hours' — a scheduled time fired while the market was closed
 *   null        — an ordinary trigger that simply landed out of hours
 * Only the `idea` kind has time leaves, and entryTimeGate answers "not gated" for anything else.
 */
function _noteFor(entity) {
    return entryTimeGate(entity).timeGated ? 'off_hours' : null
}

/** Hours since the order plan was built, or null when the entity carries no stamp. */
function _ageHours(entity, nowMs) {
    const builtAt = entity?.pendingOrder?.builtAt
    if (!Number.isFinite(builtAt)) return null
    return Math.max(0, (nowMs - builtAt) / 3_600_000)
}

/** Group key: one card per user per kind. */
function _groupKey(entity) {
    return `${entity?.userId ?? ''}::${entity?.kind ?? 'idea'}`
}

/**
 * The collaborators, injectable — same shape Hermes and Talos use, so the sweep can be exercised
 * against fixed entities and a fixed clock without a Mongo or a chat server.
 */
const _DEFAULT_DEPS = {
    list:       () => entityRepo.listByOrderState('awaiting_market'),
    claim:      (id) => entityRepo.claimIf(id, { orderState: 'awaiting_market' }, { orderState: 'awaiting_confirm' }),
    isAssetOpen,
    onSingle:   (entity, routing) => routing.single(entity),
    onBatch:    (batch) => notifyOrdersReady(batch),
    now:        () => Date.now(),
}

async function _tick(deps = _DEFAULT_DEPS) {
    const d = { ..._DEFAULT_DEPS, ...deps }

    let deferred
    try {
        deferred = await d.list()
    } catch (err) {
        logger.error(LOG, 'market sweep read error:', err.message)
        return
    }
    if (!deferred?.length) return

    const nowMs   = d.now()
    const surface = deferred.filter(e => d.isAssetOpen(e?.asset, e?.asset_class))
    if (!surface.length) return

    // CLAIM FIRST, CARD SECOND, and claim every entity before posting anything. The claim is what
    // makes the card exactly-once: `claimIf` only succeeds for the caller that actually moved the
    // entity off 'awaiting_market', so an overlapping tick (or a second process) posts nothing.
    // Doing all the claims up front also means the batch card knows its true size before it speaks.
    const claimed = []
    for (const entity of surface) {
        try {
            if (await d.claim(entity.id)) claimed.push(entity)
        } catch (err) {
            logger.error(LOG, `[${entity?.id}] claim failed:`, err.message)
        }
    }
    if (!claimed.length) return

    const groups = new Map()
    for (const entity of claimed) {
        const key = _groupKey(entity)
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(entity)
    }

    logger.info(LOG, `surfacing ${claimed.length} deferred order(s) in ${groups.size} group(s)`)

    for (const entities of groups.values()) {
        const kind    = entities[0]?.kind ?? 'idea'
        const routing = KIND_ROUTING[kind]
        // An unknown kind still gets UNPARKED above — the order is live and confirmable in the UI —
        // it just has no card. Louder than silence, and never a reason to leave it parked.
        if (!routing) {
            logger.warn(LOG, `no card routing for kind '${kind}' — ${entities.length} order(s) surfaced silently`)
            continue
        }

        try {
            if (entities.length === 1) {
                // One order: the desk's own entry-confirm card, unchanged. The batch card would be
                // a worse version of it — it says less and knows less about why this one is late.
                await d.onSingle(entities[0], routing)
                continue
            }
            const ages = entities.map(e => _ageHours(e, nowMs)).filter(v => v != null)
            await d.onBatch({
                userId: entities[0]?.userId ?? null,
                entities,
                kind,
                botId: routing.botId,
                // The OLDEST plan in the batch — the one most likely to have drifted.
                staleHours: ages.length ? Math.max(...ages) : null,
            })
        } catch (err) {
            // The entities are already unparked and visible in the UI; a failed card must not undo
            // that or abort the remaining groups.
            logger.warn(LOG, `surface notify failed for kind '${kind}':`, err.message)
        }
    }
}

const _loop = createPollLoop({
    intervalMs: POLL_INTERVAL_MS, tick: _tick, eager: true, log: LOG, name: 'market-open sweep',
})

export const marketOpenMonitor = { start: _loop.start, stop: _loop.stop }

// Test seams — the tick and the pure helpers, so the sweep can be exercised without a clock or a DB.
export { _tick, _noteFor, _ageHours, _groupKey, STALE_HOURS }
