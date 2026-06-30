/**
 * Monitor service — public interface for the monitoring system.
 *
 * Usage (server.js):
 *   import { monitorService } from './monitoring/monitor.service.js'
 *   monitorService.start()
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
import { checkInvalidation }                    from './invalidation.monitor.js'
import { checkPortfolioReviews }               from './portfolio.monitor.js'
import { checkPosition }                        from './positionMonitor.js'
import {
    fetchCandles, buildSymbolMap, buildVolumeCtx,
    hasCumulativeVolume, logCheck, persistConditionStates,
    resolveEntryTimeframe, resolveStopTimeframe, resolveTpTimeframe,
} from './monitorUtils.js'

const LOG        = '[monitor.service]'
const COLLECTION = 'ideas'

const POLL_INTERVAL_MS = 60_000

// In-memory: ideaId → timestamp of last check (resets on restart — fine for MVP)
const _lastChecked = new Map()

let _timer   = null
let _running = false

// ─── Public interface ─────────────────────────────────────────────────────────

export const monitorService = { start, stop, resetIdea }

function resetIdea(id) {
    _lastChecked.delete(id)
    logger.info(LOG, `Reset check timer for idea ${id}`)
}

function start() {
    if (_timer) return
    logger.info(LOG, 'Monitoring service starting')
    _tick()
    _timer = setInterval(_tick, POLL_INTERVAL_MS)
}

function stop() {
    if (!_timer) return
    clearInterval(_timer)
    _timer = null
    logger.info(LOG, 'Monitoring service stopped')
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function _tick() {
    if (_running) {
        logger.warn(LOG, 'Previous tick still running — skipping')
        return
    }
    _running = true
    try {
        let db, ideas
        try {
            db    = await getDb()
            ideas = await db.collection(COLLECTION)
                .find({ status: { $in: ['looking', 'long', 'short'] } })
                .toArray()
        } catch (err) {
            logger.error(LOG, 'DB read error in tick:', err.message)
            return
        }

        await _marketSweep(db)
        await checkPortfolioReviews().catch(err => logger.error(LOG, 'Portfolio review check failed', err.message))

        if (!ideas || ideas.length === 0) return
        logger.info(LOG, `Checking ${ideas.length} idea(s) (looking + long + short)`)

        for (const idea of ideas) {
            await _checkIdea(db, idea)
        }
    } finally {
        _running = false
    }
}

// ─── Deferred-order market sweep ──────────────────────────────────────────────

async function _marketSweep(db) {
    let deferred
    try {
        deferred = await db.collection(COLLECTION).find({ orderState: 'awaiting_market' }).toArray()
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
    }
}

// ─── Per-idea check ───────────────────────────────────────────────────────────

async function _checkIdea(db, idea) {
    const { id, asset, status } = idea

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
    if ((isIntradayTimeframe(fastestTf) || cumVol) && !isAssetOpen(asset, idea.asset_class)) {
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

    try {
        if (status === 'looking') {
            const candles = await fetchCandles(id, asset, entryTf)
            if (!candles) return
            _lastChecked.set(id, Date.now())
            logCheck(id, asset, status, entryTf, candles)
            await _checkEntry(db, idea, candles)

        } else if (isPosition) {
            const stopCandles = await fetchCandles(id, asset, stopTf)
            if (!stopCandles) return

            const tpCandles = tpTf === stopTf ? stopCandles : await fetchCandles(id, asset, tpTf)
            if (!tpCandles) return

            const aeCandles = entryTf === stopTf ? stopCandles : await fetchCandles(id, asset, entryTf)
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
    const volCtx    = await buildVolumeCtx(id, asset, idea.asset_class, idea.entry_condition_tree, idea.entry_conditions)

    const floorAt = idea.entryFloorAt ?? idea.savedAt ?? null

    let triggered = false
    let triggerAt = null
    const entryStates = []

    if (idea.entry_condition_tree) {
        logger.info(LOG, `[${id}] Evaluating entry condition tree`)
        ;({ triggered, triggerAt } = await evaluateTree(idea.entry_condition_tree, symbolMap, asset, floorAt, [], entryStates, volCtx))
    } else if (Array.isArray(idea.entry_conditions) && idea.entry_conditions.length > 0) {
        logger.info(LOG, `[${id}] Evaluating entry conditions (legacy flat format)`)
        const entryLogic = idea.entry_logic ?? 'AND'
        ;({ triggered, triggerAt } = await evaluateConditions(idea.entry_conditions, entryLogic, symbolMap, asset, floorAt))
    } else {
        logger.warn(LOG, `Idea ${id} has no entry conditions — skipping`)
        return
    }

    await persistConditionStates(db, idea, 'entry', entryStates, COLLECTION)

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
    } else {
        logger.info(LOG, `⏳ Entry not triggered yet for idea ${id} (${asset})`)
        await checkInvalidation(db, idea, symbolMap, { inPosition: false })
    }
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
    await db.collection(COLLECTION).updateOne({ id }, { $set: fields })
    logger.info(LOG, `Patched idea ${id}:`, fields)
}
