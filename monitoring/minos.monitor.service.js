/**
 * Minos — the trade-idea monitor (public interface for the idea monitoring system).
 *
 * ⚠ ARCHIVED 2026-07-29 — NOT STARTED. Its kind, `idea` (condition trees), is superseded by
 * Kairos's `call` (watched by Hermes) and Mentor's `setup` (watched by Talos), and nothing
 * builds a legacy idea any more. server.js no longer calls start(), so this file's poll loop
 * never runs and it emits no logs.
 *
 * Why it was switched off: it was waking on `setup` entities that belong to Talos. `_tick`
 * lists by STATUS (looking/long/short), which is shared vocabulary across every kind, and the
 * only kind guard was a single `kind === 'call'` skip — so setups fell straight through it.
 * Hermes and Talos both filter by kind in the QUERY; this one didn't. That gap is now closed
 * below (KIND) so reviving it can't reintroduce the leak.
 *
 * `resetIdea` and `preflightEntry` stay exported and wired into tradeIdeas.service.js: both are
 * no-ops for anything that isn't a legacy idea (preflightEntry only acts on entry_condition_tree),
 * so the live CRUD path is unaffected either way.
 *
 * To revive: uncomment the import + start() in server.js.
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
import { collectSymbols, resolveConditionTree } from '../services/conditionTree.service.js'
import { entryTimeGate as _entryTimeGate } from '../services/entryTimeGate.util.js'
import { checkInvalidation }                    from './invalidation.monitor.js'
import { checkPosition }                        from './positionMonitor.js'
import { notifyManualEntry, entryLegFromIdea }  from '../services/manualNotify.service.js'
import { notifyIdeaEntryConfirm }               from '../services/tradeNotify.service.js'
import { entityRepo }                           from '../services/entity/entityRepo.service.js'
import {
    fetchCandles, buildSymbolMap, buildVolumeCtx, brokerCandleCtx,
    hasCumulativeVolume, logCheck, persistConditionStates,
    resolveEntryTimeframe, resolveStopTimeframe, resolveTpTimeframe, createPollLoop,
} from './monitorUtils.js'
import { withTimeout } from '../services/timeout.util.js'

const LOG  = '[minos.monitor]'
const KIND = 'idea'   // the one kind Minos owns — see the ARCHIVED note at the top

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
    // Silent while archived: tradeIdeas.service.js calls this on every 'looking' update — for
    // CALLS and SETUPS too — so logging here would put an archived monitor's name in the log on
    // a path it no longer has any part in. Restore the line if Minos is ever revived.
    // logger.info(LOG, `Reset check timer for idea ${id}`)
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function _tick() {
    let db, ideas
    try {
        db    = await getDb()
        // Status is SHARED vocabulary — 'looking' is a call's and a setup's status too, so the
        // status list alone selects other monitors' work. Minos owns exactly one kind. Legacy
        // docs pre-date the kind field, so a missing kind still reads as 'idea'.
        ideas = (await entityRepo.listByStatus(['looking', 'long', 'short']))
            .filter(e => (e?.kind ?? KIND) === KIND)
    } catch (err) {
        logger.error(LOG, 'DB read error in tick:', err.message)
        return
    }

    // Evict stale check-timers (ideas closed/deleted since the last tick) so
    // _lastChecked stays bounded over the process lifetime.
    const liveIds = new Set((ideas ?? []).map(i => i.id))
    for (const id of _lastChecked.keys()) if (!liveIds.has(id)) _lastChecked.delete(id)

    if (!ideas || ideas.length === 0) return
    logger.info(LOG, `Checking ${ideas.length} idea(s) (looking + long + short)`)

    for (const idea of ideas) {
        try { await withTimeout(_checkIdea(db, idea), CHECK_TIMEOUT_MS) }
        catch (err) { logger.error(LOG, `Idea check timed out/failed for ${idea.id}:`, err.message) }
    }
}

// ─── Deferred-order market sweep — MOVED ──────────────────────────────────────
//
// `_marketSweep` used to live here, and that was the bug. It is the drain for `awaiting_market`,
// which THREE kinds write (idea + portfolio_item via _attachImmediatePlan, and setup via Talos) —
// but it ran inside the one monitor that owns a single kind, so when Minos was archived every
// deferred order in the app stopped waking up. Nothing flipped them back; they parked forever.
//
// It now lives in monitoring/marketOpen.monitor.js, started on its own, and is kind-blind by
// design. Do NOT reinstate a copy here if Minos is ever revived — two sweeps over one orderState
// would double-post the confirm card.
//
// The entry time-gate it used moved to services/entryTimeGate.util.js for the same reason (two
// callers, one mechanism). Re-exported under its historical name so importers/tests resolve.
export { _entryTimeGate }

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

    // Hermes-owned position (a Kairos call): Hermes is the sole in-position brain and drives exits
    // through the reconciler's hands. Minos — and checkInvalidation, called from within this
    // function — stand down so two brains can't fight the same broker orders. Ownership is now
    // KIND-DERIVED: a call is Hermes's, ownerForKind('call')==='hermes'. There is no `ownedBy`
    // flag to fall back on — a confirmed call self-executes (P3b), so kind IS the ownership.
    if (idea.kind === 'call') {
        logger.info(LOG, `[${id}] Hermes-owned — Minos standing down`)
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
    // the market-open sweep). So it stays monitored when the market is closed, regardless of timeframe;
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
            // here (they defer to awaiting_market and the market-open sweep marks them 'off_hours').
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
