/**
 * The software exit monitor — the owner `positionMonitor.checkPosition` has been missing.
 *
 * WHAT WAS BROKEN. `protectionPlan.routeExits` splits every stop/TP leg in two: a `touch` leaf is a
 * pure price and rests at the broker as a closing order, and EVERYTHING ELSE — a structured
 * candle-close compare, an indicator, a chart or news leaf, a time leaf, a cross-asset reference, a
 * nested group — stays on the software monitor, which is the only thing that can read it.
 * `checkPosition` is that monitor. Minos was its only caller, and Minos was deleted on 2026-08-18.
 * Nothing replaced it, so the capability was fully wired except for the part that RUNS it: a leg
 * routed to the monitor was accepted, stored, and shown as protection while nothing ever looked at
 * it. The guard in `routeExits` (`unmonitoredExitLegs`) made that loud. This makes it false.
 *
 * WHY IT IS KIND-BLIND, like marketOpen. The state it drains is written by more than one kind: an
 * `idea`, a `portfolio_item` (a holding IS an idea document carrying a portfolioId) and a manual
 * position of either. Minos owned exactly ONE kind, which is precisely why switching Minos off took
 * the sweep down with it. A loop tied to an agent's lifecycle dies when that agent is archived; this
 * one is tied to a CAPABILITY, so it has no reason to be switched off with any desk.
 *
 * WHY `setup` IS EXCLUDED, and it is not an oversight. A setup states its exits as ZONES, and a zone
 * IS a price — `routeSetupZones` rests every edge at the broker and returns `monitorTree: null`
 * always. `checkPosition` speaks condition trees and cannot read a zone, so it has literally nothing
 * to do for a setup, even a manual one. Excluding the kind also keeps this loop from contending with
 * Talos over `monitor_state.next_check_at`: two loops claiming one document would each push the
 * other's schedule forward, and the one that lost would simply stop running. Talos owns `setup`;
 * this owns everything else.
 *
 * THE PRE-GATE IS LOAD-BEARING, not an optimisation. Every live position is selected, but almost all
 * of them are protected entirely by broker-resting orders and have no monitored leg at all —
 * `checkPosition` skips those too, AFTER paying for three candle fetches each. We have throttled
 * ourselves off our own price provider once already by polling (project_fmp_quota_price_feed), and
 * this loop sees every open position in the app. So `hasMonitoredWork` answers the question BEFORE
 * any IO, and a position with nothing on the monitor costs one Mongo write.
 *
 * WHAT IT DOES NOT DO. It does not watch ENTRY conditions. Minos did, and for the `idea` kind that
 * is a second unowned capability — but it is a different one, with its own order-plan and confirm-
 * card path, and folding it in here would make this loop the thing it exists to replace.
 */

import { ENTITIES }            from '../services/entity/entityCollection.js'
import { LIVE_POSITION }       from '../services/entity/vocabulary.js'
import { getDb }               from '../providers/mongodb.provider.js'
import { logger }              from '../services/logger.service.js'
import { getMarketStatus }     from '../services/market.service.js'
import { getCheckGap, isIntradayTimeframe } from '../services/timeframe.service.js'
import { entityRepo }          from '../services/entity/entityRepo.service.js'
import { createDueLoop }       from './dueLoop.js'
import { checkPosition }       from './positionMonitor.js'
import {
    fetchCandles, brokerCandleCtx, hasCumulativeVolume, logCheck,
    resolveEntryTimeframe, resolveStopTimeframe, resolveTpTimeframe,
} from './monitorUtils.js'

const LOG = '[exit.monitor]'

const POLL_INTERVAL_MS = 60_000
// Matches Talos. Deliberately LONGER than the poll interval: dueLoop's lease horizon is the check
// timeout, so a shorter one would let the next tick re-select an entity whose abandoned check is
// still in flight — and `withTimeout` abandons a check, it cannot cancel it. Two live evaluations of
// one stop is how a monitor sends two closing orders.
const CHECK_TIMEOUT_MS = 90_000

// The floor on how often ONE position is re-read. A 1-minute leg wants a 1-minute cadence and that
// is as fast as this goes; the poll interval is the same, so nothing is gained by asking for less.
const MIN_GAP_MS = 60_000
// A position we cannot act on at all (no venue) still gets re-read, but at a cost that rounds to
// nothing — the venue can come back, and a stop that silently stopped being watched is the bug.
const IDLE_GAP_MS = 60 * 60_000

const _deps = {
    getDb,
    getMarketStatus,
    fetchCandles,
    checkPosition,
    patch: (id, fields) => entityRepo.patch(id, fields),
}
export function _setDeps(d) { Object.assign(_deps, d) }

// The wake-up chore lives in dueLoop.js — find what is due, claim it against a lease, check it under
// a timeout. What stays here is what makes this the exit loop: which documents, and the check.
const _loop = createDueLoop({
    collection: ENTITIES,
    // LIVE only. 'hit' is past entry but pre-fill — awaiting the user's confirm or a manual report —
    // so there is no position to exit and no quantity to exit it with.
    statuses:   LIVE_POSITION,
    // `$ne` MATCHES A MISSING FIELD (absent reads as null, and null ≠ 'setup'), which is what we
    // want: a legacy document written before `kind` existed is an idea and must stay watched. This
    // is the opposite of Talos's `broker: {$ne: null}`, where absent DOES read as null and is
    // therefore excluded — the same operator, two different answers, worth reading twice.
    filter:     { kind: { $ne: 'setup' } },
    check:      (idea, nowMs) => _checkExit(idea, nowMs, _deps),
    intervalMs: POLL_INTERVAL_MS,
    checkTimeoutMs: CHECK_TIMEOUT_MS,
    log: LOG, name: 'exit monitor',
})

export const exitMonitor = { start: _loop.start, stop: _loop.stop }

/**
 * Is there anything on the SOFTWARE monitor for this position, before we spend a single fetch?
 *
 * It mirrors `_evaluateExit`'s own gates rather than guessing at them — get this wrong in the
 * permissive direction and we burn quota; wrong in the strict direction and a stop stops being
 * watched, which is the whole failure this loop exists to end. So each leg answers exactly what
 * `checkPosition` would answer:
 *
 *   • `monitorStop === false` — routeExits found only touch leaves and the BROKER holds this leg.
 *     Explicitly false, never merely absent: a legacy document that predates the flag has no opinion
 *     and must be evaluated, not skipped.
 *   • a residual `{leg}MonitorTree` — the non-touch leaves, and the reason this loop exists.
 *   • otherwise the FULL tree/flat conditions, which is the shape a manual position leaves behind:
 *     `confirmManualEntry` writes `monitorStop = hasAny` and no residual tree, because a manual
 *     position has no venue to rest anything at and the monitor therefore owns the whole leg.
 *
 * Additional entries count too — `checkPosition` evaluates them on the same wake, and one that is
 * neither filled nor triggered is live work.
 *
 * @param {object} idea
 * @returns {boolean}
 */
export function hasMonitoredWork(idea) {
    const leg = (phase, flag) => {
        if (idea?.[flag] === false) return false
        if (idea?.[`${phase}MonitorTree`]) return true
        return !!(idea?.[`${phase}_condition_tree`] || idea?.[`${phase}_conditions`]?.length)
    }
    const pendingEntry = (idea?.additional_entries ?? []).some(ae => !ae?.filledAt && !ae?.triggeredAt)
    return leg('stop', 'monitorStop') || leg('tp', 'monitorTp') || pendingEntry
}

/**
 * How often this position wants to be read, and whether reading it needs a live tape.
 *
 * The gap is the FASTEST leg's — a daily target must not slow down a 5-minute stop. Cumulative
 * volume is measured from the session open, so it is only meaningful minute by minute and pulls the
 * cadence to the floor whichever timeframe the leg claims.
 *
 * Residual trees are consulted alongside the authored ones: after routing, the monitored half of a
 * leg lives in `{leg}MonitorTree`, and asking only the authored tree would miss a volume leaf that
 * survived the split.
 */
export function _cadence(idea) {
    const stopTf  = resolveStopTimeframe(idea)
    const tpTf    = resolveTpTimeframe(idea)
    const entryTf = resolveEntryTimeframe(idea)

    const cumVol = hasCumulativeVolume(idea?.stopMonitorTree ?? idea?.stop_condition_tree, idea?.stop_conditions)
                || hasCumulativeVolume(idea?.tpMonitorTree   ?? idea?.tp_condition_tree,   idea?.tp_conditions)

    let gap = Math.min(getCheckGap(stopTf), getCheckGap(tpTf), getCheckGap(entryTf))
    if (cumVol) gap = MIN_GAP_MS

    const fastestTf = [stopTf, tpTf, entryTf].reduce((a, b) => (getCheckGap(a) <= getCheckGap(b) ? a : b))
    return { stopTf, tpTf, entryTf, gap, needsLiveTape: isIntradayTimeframe(fastestTf) || cumVol }
}

/**
 * One position. Returns a short reason string, so a test (and the tick log) can tell "checked" from
 * "deliberately skipped" — the two used to look identical from the outside, which is how a monitor
 * that had quietly stopped working still looked busy.
 */
export async function _checkExit(idea, nowMs, deps = _deps) {
    const { id, asset } = idea

    // An explicit null broker means no trading venue was ever resolved: the monitor could watch a
    // stop trip and have nowhere to send the close. `=== null` ONLY — a legacy document predating
    // the field is `undefined`, and dropping those would silently unwatch the oldest positions in
    // the book, which are exactly the ones nobody is looking at.
    if (idea.broker === null) {
        await _reschedule(idea, nowMs, IDLE_GAP_MS, deps)
        return 'no_venue'
    }

    const plan = _cadence(idea)

    if (!hasMonitoredWork(idea)) {
        await _reschedule(idea, nowMs, plan.gap, deps)
        return 'nothing_monitored'
    }

    // An intraday leg reads the live tape, and a shut venue has none — the last candle would be
    // re-evaluated over and over against a price nobody could have traded. Sleep until the open
    // rather than burning the cadence on it. A daily leg is exempt: its candle is already closed.
    if (plan.needsLiveTape) {
        const status = deps.getMarketStatus(asset, idea.asset_class)
        if (!status?.open) {
            const untilOpen = Number.isFinite(status?.nextOpenMs) && status.nextOpenMs > nowMs
                ? status.nextOpenMs - nowMs
                : plan.gap
            await _reschedule(idea, nowMs, untilOpen, deps)
            logger.info(LOG, `[${id}] venue shut — sleeping until it opens (${asset})`)
            return 'market_closed'
        }
    }

    // Primary-instrument candles come from the BROKER (shifted back to authored price space) when
    // the broker can serve them, else the app feed. Built once and threaded through all three
    // fetches, so a position's stop and its target are never judged in two different price spaces.
    const cctx = brokerCandleCtx(idea)

    const stopCandles = await deps.fetchCandles(id, asset, plan.stopTf, undefined, cctx)
    if (!stopCandles) return _noCandles(idea, nowMs, plan, deps)
    // Re-use rather than re-fetch when the legs share a timeframe — the common case by far, since
    // `resolveTpTimeframe` falls back to the entry timeframe exactly as the stop does.
    const tpCandles = plan.tpTf === plan.stopTf ? stopCandles : await deps.fetchCandles(id, asset, plan.tpTf, undefined, cctx)
    if (!tpCandles) return _noCandles(idea, nowMs, plan, deps)
    const aeCandles = plan.entryTf === plan.stopTf ? stopCandles : await deps.fetchCandles(id, asset, plan.entryTf, undefined, cctx)
    if (!aeCandles) return _noCandles(idea, nowMs, plan, deps)

    logCheck(id, asset, idea.status, `stop=${plan.stopTf}/tp=${plan.tpTf}`, stopCandles)

    const db = await deps.getDb()
    await deps.checkPosition(db, idea, stopCandles, tpCandles, aeCandles, (entityId, reason) => _close(entityId, reason, deps))

    // AFTER the check, not before: the check is what decides whether this position still exists, and
    // a schedule written first would be a schedule for a document that may now be closed. Harmless
    // either way — a closed entity leaves the poll's status filter — but the order says which is true.
    await _reschedule(idea, nowMs, plan.gap, deps)
    return 'checked'
}

/**
 * The alert-only close — no broker position to send anything to, so the entity is simply marked.
 * `checkPosition` hands this to its exit path as `onClose`; everything with a real position at a
 * venue goes through the broker (or the off-hours queue) inside `checkPosition` itself.
 */
async function _close(id, reason, deps = _deps) {
    await deps.patch(id, { status: 'closed', closedReason: reason, closedAt: Date.now() })
    logger.info(LOG, `[${id}] closed by the monitor (${reason}) — no broker position to send to`)
}

/** A provider that could not answer is a reason to come back, not a reason to give up on the leg. */
function _noCandles(idea, nowMs, plan, deps) {
    logger.warn(LOG, `[${idea.id}] no candles for ${idea.asset} — retrying on the next cadence`)
    return _reschedule(idea, nowMs, plan.gap, deps).then(() => 'no_candles')
}

/**
 * Write when this position next wants reading. This REPLACES the lease dueLoop stamped before the
 * check — which is the design: the lease is a short hold so nothing else picks the entity up mid-
 * check, and the real cadence is only knowable once we have looked at it.
 *
 * Minos kept this in an in-memory Map, which meant every restart re-checked the whole book at once
 * and a position's cadence was forgotten along with it. Persisted, it survives a deploy.
 */
async function _reschedule(idea, nowMs, gapMs, deps) {
    const at = new Date(nowMs + Math.max(MIN_GAP_MS, Number(gapMs) || 0)).toISOString()
    await deps.patch(idea.id, { 'monitor_state.next_check_at': at })
}

// Test seams.
export { _close, _reschedule }
