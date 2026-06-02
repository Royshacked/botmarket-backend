/**
 * Monitor service — public interface for the monitoring system.
 *
 * Usage (server.js):
 *   import { monitorService } from './monitoring/monitor.service.js'
 *   monitorService.start()
 *
 * Reversibility:
 *   Remove the two lines above from server.js and delete the monitoring/ folder.
 *   No existing service files are modified.
 *
 * Fields added to idea documents (all optional, never destructive):
 *   monitorPhase      'entry' | 'position'
 *   entryTriggeredAt  timestamp (ms)
 *   closedReason      'stop' | 'tp'
 *   closedAt          timestamp (ms)
 *
 * Timeframe fields (new schema):
 *   entry_timeframe   e.g. "5min" | "4hr" | "day"
 *   stop_timeframe    inherits entry_timeframe if null
 *   tp_timeframe      inherits entry_timeframe if null
 *   (legacy "timeframe" field still supported as fallback)
 */

import { getDb }                                from '../providers/mongodb.provider.js'
import { getCandles }                           from './providers/ohlcv.provider.js'
import { evaluateTree, evaluateConditions }     from './monitor.orchestrator.js'
import { logger }                               from '../services/logger.service.js'

const LOG        = '[monitor.service]'
const COLLECTION = 'ideas'

// How often to check the database for active ideas (ms)
const POLL_INTERVAL_MS = 60_000          // 1 minute

// In-memory: ideaId → timestamp of last check (resets on restart — fine for MVP)
const _lastChecked = new Map()

let _timer = null

// ─── Timeframe → minimum gap between checks ───────────────────────────────────

/**
 * Compute the minimum re-check gap for a given timeframe string.
 * For sub-hour bars: gap = bar width.
 * For day/week/month: gap = 4h / 24h / 24h (check a few times per bar).
 *
 * @param {string} tf  e.g. "5min", "4hr", "day", "week" — legacy also accepted
 * @returns {number}  milliseconds
 */
function getCheckGap(tf) {
    if (!tf) return 4 * 60 * 60 * 1_000   // default: 4h

    const minMatch = tf.match(/^(\d+)min$/)
    if (minMatch) return parseInt(minMatch[1], 10) * 60 * 1_000

    const hrMatch = tf.match(/^(\d+)hr$/)
    if (hrMatch) return parseInt(hrMatch[1], 10) * 60 * 60 * 1_000

    if (tf === 'day')   return  4 * 60 * 60 * 1_000  // 4h
    if (tf === 'week')  return 24 * 60 * 60 * 1_000  // 24h
    if (tf === 'month') return 24 * 60 * 60 * 1_000  // 24h

    // Legacy format support
    if (tf === 'minutes') return  5 * 60 * 1_000
    if (tf === 'hours')   return 60 * 60 * 1_000
    if (tf === 'daily')   return  4 * 60 * 60 * 1_000
    if (tf === 'weekly')  return 24 * 60 * 60 * 1_000
    if (tf === 'monthly') return 24 * 60 * 60 * 1_000

    return 4 * 60 * 60 * 1_000   // unknown → 4h fallback
}

// ─── Public interface ─────────────────────────────────────────────────────────

export const monitorService = { start, stop, resetIdea }

// Called when an idea is moved back to 'active' so the next tick checks it immediately
function resetIdea(id) {
    _lastChecked.delete(id)
    logger.info(LOG, `Reset check timer for idea ${id}`)
}

function start() {
    if (_timer) return
    logger.info(LOG, 'Monitoring service starting')
    _tick()                                    // run immediately on boot
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
    let db, ideas
    try {
        db    = await getDb()
        ideas = await db.collection(COLLECTION)
            .find({ status: { $in: ['active', 'in_position'] } })
            .toArray()
    } catch (err) {
        logger.error(LOG, 'DB read error in tick:', err.message)
        return
    }

    if (!ideas || ideas.length === 0) return
    logger.info(LOG, `Checking ${ideas.length} idea(s) (active + in_position)`)

    // Process ideas sequentially to avoid hammering the Massive API
    for (const idea of ideas) {
        await _checkIdea(db, idea)
    }
}

// ─── Per-idea check ───────────────────────────────────────────────────────────

async function _checkIdea(db, idea) {
    const { id, asset, status } = idea

    // Resolve effective timeframe — tree format first, then legacy fallbacks
    const tf = _resolveEntryTimeframe(idea)

    const gap = getCheckGap(tf)

    // Skip if we checked this idea too recently
    const lastAt = _lastChecked.get(id) ?? 0
    if (Date.now() - lastAt < gap) return

    _lastChecked.set(id, Date.now())

    let candles
    try {
        candles = await getCandles(asset, tf, 60)
    } catch (err) {
        logger.error(LOG, `Candle fetch error for ${asset}:`, err.message)
        return
    }

    if (!candles || candles.length < 5) {
        logger.warn(LOG, `Skipping idea ${id} — insufficient candles for ${asset}/${tf}`)
        return
    }

    const lastCandle = candles[candles.length - 1]
    const close = lastCandle?.c ?? lastCandle?.close ?? '?'
    logger.info(LOG, `──── Check ${id} | ${asset} | status=${status} | tf=${tf} | close=${close}`)

    try {
        if (status === 'active') {
            await _checkEntry(db, idea, candles)
        } else if (status === 'in_position') {
            await _checkPosition(db, idea, candles)
        }
    } catch (err) {
        logger.error(LOG, `Error processing idea ${id}:`, err.message)
    }
}

// ─── Entry phase ──────────────────────────────────────────────────────────────

async function _checkEntry(db, idea, candles) {
    const { id, asset } = idea

    let triggered = false

    if (idea.entry_condition_tree) {
        // New tree format
        logger.info(LOG, `[${id}] Evaluating entry condition tree`)
        ;({ triggered } = await evaluateTree(idea.entry_condition_tree, candles, asset))
    } else if (Array.isArray(idea.entry_conditions) && idea.entry_conditions.length > 0) {
        // Legacy flat-array format
        logger.info(LOG, `[${id}] Evaluating entry conditions (legacy flat format)`)
        const entryLogic = idea.entry_logic ?? 'AND'
        ;({ triggered } = await evaluateConditions(idea.entry_conditions, entryLogic, candles, asset))
    } else {
        logger.warn(LOG, `Idea ${id} has no entry conditions — skipping`)
        return
    }

    if (triggered) {
        logger.info(LOG, `✅ Entry triggered for idea ${id} (${asset}) — status → triggered, awaiting order`)
        await _patch(db, id, { status: 'triggered', entryTriggeredAt: Date.now() })
    } else {
        logger.info(LOG, `⏳ Entry not triggered yet for idea ${id} (${asset})`)
    }
}

// ─── Position phase (stop / TP) ───────────────────────────────────────────────

async function _checkPosition(db, idea, candles) {
    const { id, asset } = idea

    let stopFired = false
    let tpFired   = false

    // ── Stop conditions ───────────────────────────────────────────────────────
    if (idea.stop_condition_tree) {
        logger.info(LOG, `[${id}] Evaluating stop condition tree`)
        const { triggered, which } = await evaluateTree(idea.stop_condition_tree, candles, asset)
        if (triggered) {
            logger.info(LOG, `🛑 Stop triggered for idea ${id}: "${(which ?? '').slice(0, 60)}"`)
            await _close(db, id, 'stop')
            stopFired = true
        }
    } else if (Array.isArray(idea.stop_conditions) && idea.stop_conditions.length > 0) {
        const stopLogic = idea.stop_logic ?? 'OR'
        const { triggered, which } = await evaluateConditions(idea.stop_conditions, stopLogic, candles, asset)
        if (triggered) {
            logger.info(LOG, `🛑 Stop triggered for idea ${id}: "${which?.slice(0, 60)}"`)
            await _close(db, id, 'stop')
            stopFired = true
        }
    } else {
        logger.info(LOG, `[${id}] No stop conditions defined — skipping stop check`)
    }

    if (stopFired) return

    // ── TP conditions ─────────────────────────────────────────────────────────
    if (idea.tp_condition_tree) {
        logger.info(LOG, `[${id}] Evaluating TP condition tree`)
        const { triggered, which } = await evaluateTree(idea.tp_condition_tree, candles, asset)
        if (triggered) {
            logger.info(LOG, `🎯 TP triggered for idea ${id}: "${(which ?? '').slice(0, 60)}"`)
            await _close(db, id, 'tp')
            tpFired = true
        }
    } else if (Array.isArray(idea.tp_conditions) && idea.tp_conditions.length > 0) {
        const tpLogic = idea.tp_logic ?? 'OR'
        const { triggered, which } = await evaluateConditions(idea.tp_conditions, tpLogic, candles, asset)
        if (triggered) {
            logger.info(LOG, `🎯 TP triggered for idea ${id}: "${which?.slice(0, 60)}"`)
            await _close(db, id, 'tp')
            tpFired = true
        }
    } else {
        logger.info(LOG, `[${id}] No TP conditions defined — skipping TP check`)
    }

    if (!stopFired && !tpFired) {
        logger.info(LOG, `💤 No exit triggered for idea ${id} (${asset}) — still in position`)
    }
}

// ─── Timeframe helpers ────────────────────────────────────────────────────────

/**
 * Find the effective entry timeframe for an idea.
 * Checks tree leaves first, then legacy flat fields.
 */
function _resolveEntryTimeframe(idea) {
    if (idea.entry_condition_tree) {
        const leaf = _firstLeaf(idea.entry_condition_tree)
        if (leaf?.timeframe) return leaf.timeframe
    }
    return idea.entry_conditions?.[0]?.timeframe
        ?? idea.entry_timeframe
        ?? idea.timeframe
        ?? 'day'
}

/** Return the first leaf node found in a condition tree (depth-first). */
function _firstLeaf(node) {
    if (!node) return null
    if (typeof node.condition === 'string') return node
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            const found = _firstLeaf(child)
            if (found) return found
        }
    }
    return null
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function _close(db, id, reason) {
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
