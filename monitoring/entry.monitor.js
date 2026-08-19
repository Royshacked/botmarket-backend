/**
 * The entry monitor — the second half of what died with Minos, and the last one still missing.
 *
 * WHAT WAS BROKEN. An armed entity (`status: 'looking'`) carries an entry condition tree that
 * something has to evaluate: when it comes true the entity flips to `hit`, an order plan is built,
 * and the user gets a confirm card. Minos did that, Minos was deleted on 2026-08-18, and nothing
 * took it over. So arming an idea has been a promise the app could not keep — the chips render, the
 * status says a monitor is watching (`vocabulary.LOOKING`: "a monitor is watching for entry"), and
 * nothing was. `portfolioRebalance` still arms a conditional add on exactly that promise.
 *
 * A SIBLING OF exit.monitor, NOT A MERGE, and that is the whole lesson of Minos. Minos owned the
 * entry poll, the exit poll, the invalidation monitor and the deferred-order sweep, so switching it
 * off took four capabilities down at once and nobody noticed for weeks. One loop, one capability:
 * this one can be stopped without touching exits, and exits can be stopped without touching this.
 *
 * They cannot contend, either. This polls `looking`; exits poll `long`/`short`. A document is never
 * both, so although the two share `monitor_state.next_check_at` they can never claim the same one.
 * `setup` is excluded here for the same reason it is there: Talos owns setup READINESS, which is
 * this question asked about zones, and it already claims that field on those documents.
 *
 * THE RISING EDGE IS THE POINT. Entry evaluates with `requireHeld`, against a floor
 * (`entryFloorAt`), so a level that was ALREADY true when the user armed does not fire — otherwise
 * every armed idea would trigger on its first wake. The corollary is that a breakout which happened
 * before the arm can never fire at all, which is what `preflightEntry` warns about at arm time.
 *
 * ARMING MUST CLEAR THE SCHEDULE. Minos kept its cadence in an in-memory Map that `resetIdea`
 * cleared; this one persists it, so `tradeIdeas.updateIdea` now nulls `monitor_state.next_check_at`
 * whenever an idea is armed or its entry floor moves. Without that, re-arming an idea that had
 * already been checked would sleep up to four hours before its first look.
 */

import { ENTITIES }            from '../services/entity/entityCollection.js'
import { ARMED, STATUS }       from '../services/entity/vocabulary.js'
import { logger }              from '../services/logger.service.js'
import { getMarketStatus }     from '../services/market.service.js'
import { getCheckGap, isIntradayTimeframe } from '../services/timeframe.service.js'
import { entityRepo }          from '../services/entity/entityRepo.service.js'
import { collectSymbols, resolveConditionTree } from '../services/conditionTree.service.js'
import { entryTimeGate }       from '../services/entryTimeGate.util.js'
import { buildOrderPlanForIdea } from '../services/orderPlan.service.js'
import { notifyManualEntry, entryLegFromIdea } from '../services/manualNotify.service.js'
import { notifyIdeaEntryConfirm } from '../services/tradeNotify.service.js'
import { isSelfExecuted }        from '../services/venue.resolve.service.js'
import { createDueLoop }       from './dueLoop.js'
import { evaluateTree, evaluateConditions, isTimeBlocked } from './monitor.orchestrator.js'
import {
    fetchCandles, brokerCandleCtx, hasCumulativeVolume, logCheck, persistConditionStates,
    buildSymbolMap, buildVolumeCtx, resolveEntryTimeframe,
} from './monitorUtils.js'

const LOG = '[entry.monitor]'

const POLL_INTERVAL_MS = 60_000
// Longer than the poll interval, like every other dueLoop caller: the lease horizon IS the check
// timeout, and a shorter one lets the next tick re-select an entity whose abandoned check is still
// running. Here that would build a second order plan and post a second confirm card.
const CHECK_TIMEOUT_MS = 90_000

const MIN_GAP_MS  = 60_000
// An armed entity we cannot act on — no venue, or nothing to evaluate — still gets re-read, but at
// a cost that rounds to nothing. It must never be dropped: silently unwatching an armed idea is the
// exact failure this monitor exists to end.
const IDLE_GAP_MS = 60 * 60_000

const _deps = {
    getMarketStatus,
    // Reads the WALL CLOCK internally (evaluateTime defaults to Date.now), which makes it exactly
    // the kind of collaborator this object exists for — without it the clock gates cannot be
    // exercised at a fixed instant, only at whatever time the suite happens to run.
    isTimeBlocked,
    fetchCandles,
    buildSymbolMap,
    buildVolumeCtx,
    evaluateTree,
    evaluateConditions,
    // Same absorbed vestigial `db` as positionMonitor's — the write funnels through entityRepo.
    persistStates: (idea, phase, states) => persistConditionStates(null, idea, phase, states),
    buildOrderPlan: (idea) => buildOrderPlanForIdea(idea),
    notifyManualEntry,
    notifyIdeaEntryConfirm,
    patch: (id, fields) => entityRepo.patch(id, fields),
}
export function _setDeps(d) { Object.assign(_deps, d) }

const _loop = createDueLoop({
    collection: ENTITIES,
    // ARMED is 'looking' and only 'looking'. 'waiting' is deliberately NOT polled — arming is the
    // user's separate act, and a monitor that watched drafts would fire trades nobody asked for.
    statuses:   ARMED,
    // Talos owns setup readiness. `$ne` matches a MISSING kind too, so a legacy idea written before
    // the field existed is still watched — which is most of what is armed in an old book.
    filter:     { kind: { $ne: 'setup' } },
    check:      (idea, nowMs) => _checkArmed(idea, nowMs, _deps),
    intervalMs: POLL_INTERVAL_MS,
    checkTimeoutMs: CHECK_TIMEOUT_MS,
    log: LOG, name: 'entry monitor',
})

export const entryMonitor = { start: _loop.start, stop: _loop.stop }

/**
 * DOES THIS EDIT MEAN "CHECK IT NOW"? — and `ENTRY_SCHEDULE_FIELD` is what it must clear.
 *
 * Exported and used by `tradeIdeas.updateIdea` rather than spelled out there, because it is a fact
 * about THIS monitor: the cadence is persisted (Minos kept its in an in-memory Map that `resetIdea`
 * cleared, and that Map went with Minos), so a stale wake-up time left from a previous arm would
 * make the loop sleep straight through the new one — up to four hours on a daily entry, silently,
 * on an idea the user just armed. A magic string in the CRUD path would drift the first time this
 * loop changed where it keeps its schedule.
 *
 * TWO EVENTS, one meaning. Arming is the obvious one. Pushing the entry FLOOR forward is the same
 * thing under another name — the arm-time pre-flight "Reset", and the re-arm path — because it
 * changes which cross would fire, so the old cadence is no longer the right time to look.
 */
export const ENTRY_SCHEDULE_FIELD = 'monitor_state.next_check_at'

export function clearsEntrySchedule(patch) {
    return patch?.status === STATUS.LOOKING || patch?.entryFloorAt !== undefined
}

/** Something to evaluate at all. An armed entity with no entry conditions can never fire. */
export function hasEntryWork(idea) {
    return !!(idea?.entry_condition_tree || idea?.entry_conditions?.length)
}

/** How often this entity wants reading, and whether reading it needs a live tape. */
export function _cadence(idea) {
    const entryTf = resolveEntryTimeframe(idea)
    const cumVol  = hasCumulativeVolume(idea?.entry_condition_tree, idea?.entry_conditions)
    return {
        entryTf,
        cumVol,
        gap: cumVol ? MIN_GAP_MS : getCheckGap(entryTf),
        needsLiveTape: isIntradayTimeframe(entryTf) || cumVol,
    }
}

/**
 * One armed entity. Returns a short reason, so "checked and waiting" and "deliberately skipped" are
 * distinguishable from the outside — the two used to look identical, which is how a monitor that had
 * stopped working still looked busy.
 */
export async function _checkArmed(idea, nowMs, deps = _deps) {
    const { id, asset } = idea

    // Explicit null only: no venue was ever resolved, so a trigger could never become an order.
    // A legacy document predating the field is `undefined` and stays watched.
    if (idea.broker === null) {
        await _reschedule(idea, nowMs, IDLE_GAP_MS, deps)
        return 'no_venue'
    }

    if (!hasEntryWork(idea)) {
        logger.warn(LOG, `[${id}] armed with no entry conditions — nothing can ever fire`)
        await _reschedule(idea, nowMs, IDLE_GAP_MS, deps)
        return 'nothing_armed'
    }

    const plan = _cadence(idea)
    const gate = entryTimeGate(idea)

    // The clock alone makes this impossible right now — no candle can change that, so don't buy one.
    //
    // SLEEP TO THE CLOCK, NOT TO THE PRICE CADENCE. The cadence answers "how often is this chart
    // worth re-reading", which is the wrong question for a trigger that is waiting on a timestamp:
    // a scheduled entry ninety seconds away would wait FOUR HOURS because its timeframe happens to
    // be daily. Minos never hit this — it re-checked a time-blocked idea every tick, because the
    // blocked path returned before it stamped its in-memory throttle. A persisted schedule has to
    // say so explicitly.
    //
    // Capped at the cadence so a bound years out still gets looked at on the normal rhythm, and
    // floored at MIN_GAP_MS by `_reschedule` so a bound one second away cannot spin.
    const root = resolveConditionTree(idea.entry_condition_tree, idea.entry_conditions, idea.entry_logic ?? 'AND')
    if (deps.isTimeBlocked(root)) {
        const untilAfter = gate.after != null && gate.after > nowMs ? gate.after - nowMs : plan.gap
        await _reschedule(idea, nowMs, Math.min(untilAfter, plan.gap), deps)
        return 'time_blocked'
    }

    // A PURE SCHEDULED ENTRY IS EXEMPT, and this is the subtle one. Every leaf being a time leaf
    // means the trigger needs no market data at all: the wall clock fires it, the order defers to
    // `awaiting_market`, and the market-open sweep surfaces it. Gating that on market hours would
    // make a 3am scheduled entry impossible to express — so the exemption is what keeps off-hours
    // behaviour deterministic instead of dependent on a stray entry timeframe.
    if (plan.needsLiveTape && !gate.allTime) {
        const status = deps.getMarketStatus(asset, idea.asset_class)
        if (!status?.open) {
            const untilOpen = Number.isFinite(status?.nextOpenMs) && status.nextOpenMs > nowMs
                ? status.nextOpenMs - nowMs
                : plan.gap
            await _reschedule(idea, nowMs, untilOpen, deps)
            return 'market_closed'
        }
    }

    const candles = await deps.fetchCandles(id, asset, plan.entryTf, undefined, brokerCandleCtx(idea))
    if (!candles) {
        logger.warn(LOG, `[${id}] no candles for ${asset} — retrying on the next cadence`)
        await _reschedule(idea, nowMs, plan.gap, deps)
        return 'no_candles'
    }

    logCheck(id, asset, idea.status, plan.entryTf, candles)
    const fired = await _checkEntry(idea, candles, plan.entryTf, nowMs, deps)

    // A triggered entity is no longer 'looking', so it leaves this loop's selection on its own and
    // wants no schedule. Writing one would only stamp a document that has moved on.
    if (!fired) await _reschedule(idea, nowMs, plan.gap, deps)
    return fired ? 'triggered' : 'waiting'
}

/**
 * Evaluate the entry tree and, if it fires, do the three things that follow: flip the entity to
 * `hit`, attach an order plan, and tell the user.
 *
 * `requireHeld` is what makes this a RISING EDGE rather than a level check: a structured leg needs a
 * fresh cross since the floor AND the level still holding on the latest candle, so a breakout that
 * reverted cannot keep an AND leg latched true until a sibling (a volume leaf, say) later turns true.
 *
 * @returns {Promise<boolean>} whether the entry fired
 */
export async function _checkEntry(idea, candles, entryTf, nowMs, deps = _deps) {
    const { id, asset } = idea

    const crossSyms = collectSymbols(idea.entry_condition_tree, idea.entry_conditions)
    const symbolMap = await deps.buildSymbolMap(id, asset, candles, entryTf, crossSyms)
    const volCtx    = await deps.buildVolumeCtx(id, asset, idea.asset_class, idea.entry_condition_tree, idea.entry_conditions, brokerCandleCtx(idea))

    // The floor the rising edge is measured from — when the user armed it, not when the document
    // was created, or every re-arm would re-fire on the same old cross.
    const floorAt = idea.entryFloorAt ?? idea.savedAt ?? null

    let triggered = false
    let triggerAt = null
    const states  = []

    if (idea.entry_condition_tree) {
        ;({ triggered, triggerAt } = await deps.evaluateTree(
            idea.entry_condition_tree, symbolMap, asset, floorAt, [], states, volCtx, { requireHeld: true }))
    } else {
        ;({ triggered, triggerAt } = await deps.evaluateConditions(
            idea.entry_conditions, idea.entry_logic ?? 'AND', symbolMap, asset, floorAt, states, { requireHeld: true }))
    }

    await deps.persistStates(idea, 'entry', states)

    if (!triggered) {
        logger.info(LOG, `⏳ Entry not triggered yet for ${id} (${asset})`)
        return false
    }

    const patch = { status: STATUS.HIT, entryTriggeredAt: nowMs }

    // The trigger event predates the arm — the condition was already true in the window the floor
    // was supposed to exclude. Recorded rather than suppressed: the trade is still the one the user
    // asked for, but the FE marks it so nobody reads a stale cross as a fresh signal.
    if (triggerAt != null && idea.activatedAt != null && triggerAt < idea.activatedAt) {
        patch.triggeredWhileWaiting = true
        patch.triggerEventAt        = triggerAt
        logger.info(LOG, `[${id}] entry event predates activation (${triggerAt} < ${idea.activatedAt})`)
    }

    // SELF-EXECUTED venue (manual today): no order plan and no confirm dialog — the user places it
    // at their own institution and reports the fill, which `confirmManualEntry` books.
    if (isSelfExecuted(idea.broker)) {
        patch.orderState = 'awaiting_manual_fill'
        await deps.patch(id, patch)
        await deps.notifyManualEntry(idea.userId, { legs: [entryLegFromIdea(idea)] })
        logger.info(LOG, `✅ Entry triggered for manual ${id} (${asset}) — awaiting the user's fill`)
        return true
    }

    const plan = await deps.buildOrderPlan(idea)
    if (plan?.length > 0) {
        // NOTHING EXECUTES OFF-HOURS. A trigger on a shut venue parks at `awaiting_market` and the
        // market-open sweep wakes it with the same confirm the user would have got in hours.
        const open = deps.getMarketStatus(asset, idea.asset_class)?.open
        patch.pendingOrder = { plan, builtAt: nowMs }
        patch.orderState   = open ? 'awaiting_confirm' : 'awaiting_market'
        logger.info(LOG, `✅ Entry triggered for ${id} (${asset}) — orderState → ${patch.orderState}`)
    } else {
        logger.info(LOG, `✅ Entry triggered for ${id} (${asset}) — no accounts, alert only`)
    }

    await deps.patch(id, patch)

    // Fires once: the entity is now 'hit', so this loop will not select it again. `awaiting_market`
    // stays silent on purpose (the sweep owns that card) and "no accounts" has nothing to confirm.
    if (patch.orderState === 'awaiting_confirm') {
        // The scheduled moment had already passed when the user armed, so the entry fires on the
        // very first check. That reads as "already passed", not as a fresh trigger, and the card
        // says so rather than implying the market just did something.
        const armAt = idea.activatedAt ?? idea.savedAt ?? 0
        const note  = gateNote(entryTimeGate(idea), armAt)
        await deps.notifyIdeaEntryConfirm(idea, note)
    }
    return true
}

/** Pulled out so the one condition behind the card's note is assertable on its own. */
export function gateNote(gate, armAt) {
    return gate?.timeGated && gate.after != null && gate.after <= armAt ? 'passed_earlier' : null
}

async function _reschedule(idea, nowMs, gapMs, deps) {
    const at = new Date(nowMs + Math.max(MIN_GAP_MS, Number(gapMs) || 0)).toISOString()
    await deps.patch(idea.id, { 'monitor_state.next_check_at': at })
}

export { _reschedule }
