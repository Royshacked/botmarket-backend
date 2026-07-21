/**
 * Minos — the trade-idea monitor (public interface for the idea monitoring system).
 *
 * Usage (server.js):
 *   import { minosService } from './monitoring/minos.monitor.service.js'
 *   minosService.start()
 *
 * Fields added to idea documents (all optional, never destructive):
 *   monitorPhase      'entry' | 'position'
 *   entryTriggeredAt  timestamp (ms)
 *   closedReason      'stop' | 'tp'
 *   closedAt          timestamp (ms)
 */

import { getDb }                                from '../providers/mongodb.provider.js'
import { evaluateTree, evaluateConditions, isTimeBlocked } from './monitor.orchestrator.js'
import { logger }                               from '../services/logger.service.js'
import { isAssetOpen }                          from '../services/market.service.js'
import { buildOrderPlanForIdea }                from '../services/orderPlan.service.js'
import { getCheckGap, isIntradayTimeframe }     from '../services/timeframe.service.js'
import { collectSymbols, resolveConditionTree, extractLeaves } from '../services/conditionTree.service.js'
import { toMs } from './evaluators/time.evaluator.js'
import { checkInvalidation }                    from './invalidation.monitor.js'
import { checkPortfolioReviews }               from './portfolio.monitor.js'
import { checkPosition }                        from './positionMonitor.js'
import { notifyManualEntry, entryLegFromIdea }  from '../services/manualNotify.service.js'
import { notifyIdeaEntryConfirm }               from '../services/tradeNotify.service.js'
import { entityRepo }                           from '../services/entity/entityRepo.service.js'
import {
    fetchCandles, buildSymbolMap, buildVolumeCtx, brokerCandleCtx,
    hasCumulativeVolume, logCheck, persistConditionStates,
    resolveEntryTimeframe, resolveStopTimeframe, resolveTpTimeframe, withTimeout, createPollLoop,
} from './monitorUtils.js'

const LOG = '[minos.monitor]'

const POLL_INTERVAL_MS = 60_000
// A single idea's check awaits provider/LLM/vision IO with no inherent bound. If one
// hangs, the serial tick loop never returns, `_running` stays true, and the monitor
// dies silently until restart. Bounding each check lets a hung one reject so the loop
// recovers on the next tick. Kept under the poll interval so a timeout clears first.
const CHECK_TIMEOUT_MS = 45_000

// In-memory: ideaId → timestamp of last check (resets on restart — fine for MVP)
const _lastChecked = new Map()

const _loop = createPollLoop({ intervalMs: POLL_INTERVAL_MS, tick: _tick, eager: true, log: LOG, name: 'monitor' })

// ─── Public interface ─────────────────────────────────────────────────────────

export const minosService = { start: _loop.start, stop: _loop.stop, resetIdea, preflightEntry }

function resetIdea(id) {
    _lastChecked.delete(id)
    logger.info(LOG, `Reset check timer for idea ${id}`)
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function _tick() {
    let db, ideas
    try {
        db    = await getDb()
        ideas = await entityRepo.listByStatus(['looking', 'long', 'short'])
    } catch (err) {
        logger.error(LOG, 'DB read error in tick:', err.message)
        return
    }

    // Evict stale check-timers (ideas closed/deleted since the last tick) so
    // _lastChecked stays bounded over the process lifetime.
    const liveIds = new Set((ideas ?? []).map(i => i.id))
    for (const id of _lastChecked.keys()) if (!liveIds.has(id)) _lastChecked.delete(id)

    await _marketSweep(db)
    await checkPortfolioReviews().catch(err => logger.error(LOG, 'Portfolio review check failed', err.message))

    if (!ideas || ideas.length === 0) return
    logger.info(LOG, `Checking ${ideas.length} idea(s) (looking + long + short)`)

    for (const idea of ideas) {
        try { await withTimeout(_checkIdea(db, idea), CHECK_TIMEOUT_MS) }
        catch (err) { logger.error(LOG, `Idea check timed out/failed for ${idea.id}:`, err.message) }
    }
}

// ─── Deferred-order market sweep ──────────────────────────────────────────────

async function _marketSweep(db) {
    let deferred
    try {
        deferred = await entityRepo.listByOrderState('awaiting_market')
    } catch (err) {
        logger.error(LOG, 'Market sweep read error:', err.message)
        return
    }
    if (!deferred || deferred.length === 0) return

    const surface = deferred.filter(idea => isAssetOpen(idea.asset, idea.asset_class))
    if (surface.length === 0) return

    logger.info(LOG, `Surfacing ${surface.length} deferred order(s)`)
    for (const idea of surface) {
        await _patch(db, idea.id, { orderState: 'awaiting_confirm' })
        // Close the notification hole: an entry that triggered while the market was closed
        // parked silently as awaiting_market — now that it's open, surface the confirm card.
        // A scheduled/time entry is marked 'off_hours' so the copy reflects why it's late.
        const note = _entryTimeGate(idea).timeGated ? 'off_hours' : null
        try { await notifyIdeaEntryConfirm(idea, note) }
        catch (err) { logger.warn(LOG, `[${idea.id}] deferred-surface notify failed:`, err.message) }
    }
}

// Inspect an idea's entry tree for time gating.
//   timeGated — at least one `time` leaf gates entry
//   allTime   — EVERY entry leaf is a `time` leaf (a pure scheduled entry: needs no market
//               data, so it's monitored regardless of market hours)
//   after     — the governing (latest) `after` bound in ms, or null
// Used for the market-closed-skip exemption and the entry-confirm note. See
// project_timestamp_ideas (Phase 4). Exported for unit testing.
export function _entryTimeGate(idea) {
    const tree   = resolveConditionTree(idea?.entry_condition_tree, idea?.entry_conditions, idea?.entry_logic ?? 'AND')
    const leaves = extractLeaves(tree)
    const timeLeaves = leaves.filter(l => l?.type === 'time')
    if (timeLeaves.length === 0) return { timeGated: false, allTime: false, after: null }
    const afters = timeLeaves.map(l => toMs(l?.after)).filter(v => v != null)
    return {
        timeGated: true,
        allTime:   timeLeaves.length === leaves.length,
        after:     afters.length ? Math.max(...afters) : null,
    }
}

// ─── Per-idea check ───────────────────────────────────────────────────────────

async function _checkIdea(db, idea) {
    const { id, asset, status } = idea

    // Gate #5 backstop: an explicit null broker means no trading venue (no account
    // resolved + paper off) — the monitor could detect a trigger but never place an
    // order, so skip. `=== null` only: legacy ideas predating the broker field are
    // `undefined` and stay monitored on the app feed.
    if (idea.broker === null) {
        logger.info(LOG, `[${id}] No trading venue (broker=null) — skipping`)
        return
    }

    // Hermes-owned position (a confirmed Kairos call): Hermes is the sole in-position brain and
    // drives exits through the reconciler's hands. Minos — and checkInvalidation, called from
    // within this function — stand down so two brains can't fight the same broker orders. The
    // native stop/TP still rest at the broker (placed by the reconciler) and Hermes amends them.
    // (KAIROS_PLAN.md Phase 5.)
    if (idea.ownedBy === 'hermes') {
        logger.info(LOG, `[${id}] Owned by Hermes — Minos standing down`)
        return
    }

    const entryTf    = resolveEntryTimeframe(idea)
    const isPosition = status === 'long' || status === 'short'
    const stopTf     = isPosition ? resolveStopTimeframe(idea) : null
    const tpTf       = isPosition ? resolveTpTimeframe(idea)   : null

    let gap = isPosition
        ? Math.min(getCheckGap(stopTf), getCheckGap(tpTf), getCheckGap(entryTf))
        : getCheckGap(entryTf)

    const volPhases = isPosition
        ? [[idea.stop_condition_tree, idea.stop_conditions], [idea.tp_condition_tree, idea.tp_conditions]]
        : [[idea.entry_condition_tree, idea.entry_conditions]]
    const cumVol = volPhases.some(([t, f]) => hasCumulativeVolume(t, f))
    if (cumVol) gap = Math.min(gap, 60_000)

    const fastestTf = isPosition
        ? [stopTf, tpTf, entryTf].reduce((a, b) => getCheckGap(a) <= getCheckGap(b) ? a : b)
        : entryTf
    // A pure scheduled (time-only) entry needs no live market data — the wall-clock gate
    // fires and the order defers via awaiting_market until the market re-opens (surfaced by
    // _marketSweep). So it stays monitored when the market is closed, regardless of timeframe;
    // this makes off-hours behavior deterministic rather than dependent on a stray entry TF.
    if ((isIntradayTimeframe(fastestTf) || cumVol) && !isAssetOpen(asset, idea.asset_class)
        && !(!isPosition && _entryTimeGate(idea).allTime)) {
        logger.info(LOG, `[${id}] Market closed — skipping ${cumVol ? 'cumulative-volume' : 'intraday'} check (${asset}/${fastestTf})`)
        return
    }

    if (!isPosition) {
        const entryRoot = resolveConditionTree(idea.entry_condition_tree, idea.entry_conditions, idea.entry_logic ?? 'AND')
        if (isTimeBlocked(entryRoot)) {
            logger.info(LOG, `[${id}] Outside time window — skipping entry check (${asset})`)
            return
        }
    }

    const lastAt = _lastChecked.get(id) ?? 0
    if (Date.now() - lastAt < gap) return

    // Primary-instrument candles come from the broker (shifted to authored space) for an
    // ohlcv-capable broker, else the app feed. Built once; cross-asset legs stay app-feed.
    const cctx = brokerCandleCtx(idea)

    try {
        if (status === 'looking') {
            const candles = await fetchCandles(id, asset, entryTf, undefined, cctx)
            if (!candles) return
            _lastChecked.set(id, Date.now())
            logCheck(id, asset, status, entryTf, candles)
            await _checkEntry(db, idea, candles)

        } else if (isPosition) {
            const stopCandles = await fetchCandles(id, asset, stopTf, undefined, cctx)
            if (!stopCandles) return

            const tpCandles = tpTf === stopTf ? stopCandles : await fetchCandles(id, asset, tpTf, undefined, cctx)
            if (!tpCandles) return

            const aeCandles = entryTf === stopTf ? stopCandles : await fetchCandles(id, asset, entryTf, undefined, cctx)
            if (!aeCandles) return

            _lastChecked.set(id, Date.now())
            logCheck(id, asset, status, `stop=${stopTf}/tp=${tpTf}`, stopCandles)
            await checkPosition(db, idea, stopCandles, tpCandles, aeCandles, (ideaId, reason) => _close(db, ideaId, reason))

            // Invalidation runs in-position too (advisory): structure break → notify,
            // but the stop owns the exit. Reuses the entry-timeframe candles.
            const invMap = await buildSymbolMap(id, asset, aeCandles, entryTf, [])
            await checkInvalidation(db, idea, invMap, { inPosition: true })
        }
    } catch (err) {
        logger.error(LOG, `Error processing idea ${id}:`, err.message)
    }
}

// ─── Entry phase ──────────────────────────────────────────────────────────────

async function _checkEntry(db, idea, candles) {
    const { id, asset } = idea
    const entryTf = resolveEntryTimeframe(idea)

    const crossSyms = collectSymbols(idea.entry_condition_tree, idea.entry_conditions)
    const symbolMap = await buildSymbolMap(id, asset, candles, entryTf, crossSyms)
    const volCtx    = await buildVolumeCtx(id, asset, idea.asset_class, idea.entry_condition_tree, idea.entry_conditions, brokerCandleCtx(idea))

    const floorAt = idea.entryFloorAt ?? idea.savedAt ?? null

    let triggered = false
    let triggerAt = null
    const entryStates = []

    // requireHeld: a structured entry leg needs a fresh edge since the floor AND the
    // level still held on the latest candle — so a reverted breakout doesn't keep an
    // AND leg latched true and fire once a sibling (e.g. volume) later turns true.
    if (idea.entry_condition_tree) {
        logger.info(LOG, `[${id}] Evaluating entry condition tree`)
        ;({ triggered, triggerAt } = await evaluateTree(idea.entry_condition_tree, symbolMap, asset, floorAt, [], entryStates, volCtx, { requireHeld: true }))
    } else if (Array.isArray(idea.entry_conditions) && idea.entry_conditions.length > 0) {
        logger.info(LOG, `[${id}] Evaluating entry conditions (legacy flat format)`)
        const entryLogic = idea.entry_logic ?? 'AND'
        ;({ triggered, triggerAt } = await evaluateConditions(idea.entry_conditions, entryLogic, symbolMap, asset, floorAt, entryStates, { requireHeld: true }))
    } else {
        logger.warn(LOG, `Idea ${id} has no entry conditions — skipping`)
        return
    }

    await persistConditionStates(db, idea, 'entry', entryStates)

    if (triggered) {
        const triggeredWhileWaiting = triggerAt != null && idea.activatedAt != null && triggerAt < idea.activatedAt
        if (triggeredWhileWaiting) {
            logger.info(LOG, `[${id}] Entry event predates activation (triggerAt=${triggerAt} < activatedAt=${idea.activatedAt}) — flagging triggeredWhileWaiting`)
        }

        const patch = { status: 'hit', entryTriggeredAt: Date.now() }
        if (triggeredWhileWaiting) {
            patch.triggeredWhileWaiting = true
            patch.triggerEventAt        = triggerAt
        }

        // Manual (broker-less) idea: don't build a broker order plan — flip to hit and post
        // the "enter at your broker" card; confirmManualEntry opens the position on the
        // user's reported fill. No OrderConfirm dialog, no reconciler.
        if (idea.broker === 'manual') {
            patch.orderState = 'awaiting_manual_fill'
            await _patch(db, id, patch)
            await notifyManualEntry(idea.userId, { legs: [entryLegFromIdea(idea)] })
            logger.info(LOG, `✅ Entry triggered for manual idea ${id} (${asset}) — status → hit, awaiting user fill`)
            return
        }

        const plan = await buildOrderPlanForIdea(idea)
        if (plan.length > 0) {
            const open = isAssetOpen(asset, idea.asset_class)
            patch.pendingOrder = { plan, builtAt: Date.now() }
            patch.orderState   = open ? 'awaiting_confirm' : 'awaiting_market'
            logger.info(LOG, `✅ Entry triggered for idea ${id} (${asset}) — status → hit, orderState → ${patch.orderState}`)
        } else {
            logger.info(LOG, `✅ Entry triggered for idea ${id} (${asset}) — status → hit (no accounts; alert only)`)
        }

        await _patch(db, id, patch)

        // Notify + route to the OrderConfirmDialog. Only when a plan is actually awaiting
        // confirmation (open market); 'awaiting_market' defers silently and 'no accounts'
        // has nothing to confirm. Fires once — the idea is now 'hit', so _checkEntry won't run again.
        if (patch.orderState === 'awaiting_confirm') {
            // Mark the card when the scheduled time was already in the past when the user armed
            // the idea (after <= activation) — the entry fires on the first check, so it reads
            // as "already passed" rather than a fresh trigger. Off-hours triggers never reach
            // here (they defer to awaiting_market and _marketSweep marks them 'off_hours').
            const tg     = _entryTimeGate(idea)
            const armAt  = idea.activatedAt ?? idea.savedAt ?? 0
            const note   = tg.timeGated && tg.after != null && tg.after <= armAt ? 'passed_earlier' : null
            await notifyIdeaEntryConfirm(idea, note)
        }
    } else {
        logger.info(LOG, `⏳ Entry not triggered yet for idea ${id} (${asset})`)
        await checkInvalidation(db, idea, symbolMap, { inPosition: false })
    }
}

// ─── Pre-flight entry check ─────────────────────────────────────────────────
//
// Run once when an idea is armed (status → 'looking'): is the entry condition
// ALREADY satisfied as a static level on the last closed candle, while the
// monitor's rising-edge path would NOT fire it? That's the case where the
// breakout already happened before the floor and price never dipped back, so the
// idea would sit at 'looking' forever. We surface it (Buy now / Edit / Reset)
// instead of waiting silently.
//
// Detection: state-eval (floorAt = null → the evaluator's "true right now"
// snapshot) is true, but edge-eval (floorAt = the monitor's real floor) is false.
//
// Best-effort and never throws — on any failure it returns not-satisfied so the
// status change is unaffected.
async function preflightEntry(idea) {
    try {
        const { id, asset } = idea

        // v1 scope: only tree-based ideas whose entry is purely structured price
        // leaves. Mixed trees (indicator/chart/news/…) would drag heavy LLM
        // evaluators into a synchronous request and have fuzzier "already true"
        // semantics — skipped for now.
        const tree = idea.entry_condition_tree
        if (!tree || !_isStructuredOnly(tree)) return { alreadySatisfied: false }

        const entryTf = resolveEntryTimeframe(idea)
        const cctx    = brokerCandleCtx(idea)
        const candles = await fetchCandles(id, asset, entryTf, undefined, cctx)
        if (!candles) return { alreadySatisfied: false }

        const crossSyms = collectSymbols(tree, idea.entry_conditions)
        const symbolMap = await buildSymbolMap(id, asset, candles, entryTf, crossSyms)
        const volCtx    = await buildVolumeCtx(id, asset, idea.asset_class, tree, idea.entry_conditions, cctx)

        // Same floor the monitor uses, so edge-eval predicts real monitor behaviour.
        const floorAt = idea.entryFloorAt ?? idea.savedAt ?? null

        const edge  = await evaluateTree(tree, symbolMap, asset, floorAt, [], [], volCtx, { requireHeld: true }) // will the monitor fire?
        const state = await evaluateTree(tree, symbolMap, asset, null,   [], [], volCtx, { stateLevel: true })  // is the level held right now?

        const alreadySatisfied = !!(state.triggered && !edge.triggered)
        const close = candles.at(-1)?.c ?? null

        if (alreadySatisfied) {
            logger.info(LOG, `[${id}] Pre-flight: entry level already held but not a fresh rising edge (close=${close}) — prompting user`)
        }
        return { alreadySatisfied, close }
    } catch (err) {
        logger.warn(LOG, `Pre-flight entry check failed for idea ${idea?.id}:`, err.message)
        return { alreadySatisfied: false }
    }
}

// True when every leaf in the tree is a structured (price/indicator-math) leaf —
// no chart/news/indicator-LLM/touch/time/volume leaves. Empty/invalid → false.
function _isStructuredOnly(node) {
    if (!node || typeof node !== 'object') return false
    if (typeof node.condition === 'string') {
        const type = node.type ?? 'structured'
        return type === 'structured'
    }
    if (!Array.isArray(node.children) || node.children.length === 0) return false
    return node.children.every(_isStructuredOnly)
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function _close(db, id, reason) {
    _lastChecked.delete(id)
    await _patch(db, id, {
        status:       'closed',
        closedReason: reason,
        closedAt:     Date.now(),
    })
}

async function _patch(db, id, fields) {
    await entityRepo.patch(id, fields)   // `db` vestigial — write funnels through entityRepo (P1b)
    logger.info(LOG, `Patched idea ${id}:`, fields)
}
