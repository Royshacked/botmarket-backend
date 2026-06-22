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
import { getCandles }                           from '../providers/ohlcv.provider.js'
import { evaluateTree, evaluateConditions }     from './monitor.orchestrator.js'
import { logger }                               from '../services/logger.service.js'
import { isAssetOpen, sessionStartMs }          from '../services/market.service.js'
import { buildOrderPlanForIdea }                from '../services/orderPlan.service.js'
import { getCheckGap, isIntradayTimeframe }     from '../services/timeframe.service.js'
import { collectSymbols, firstLeaf, extractLeaves } from '../services/conditionTree.service.js'
import { brokerService }                        from '../api/broker/broker.service.js'

const LOG        = '[monitor.service]'
const COLLECTION = 'ideas'

// How often to check the database for active ideas (ms)
const POLL_INTERVAL_MS = 60_000          // 1 minute

// Candles to fetch per series — large enough for SMA(200) warmup
const CANDLE_COUNT = 300

// In-memory: ideaId → timestamp of last check (resets on restart — fine for MVP)
const _lastChecked = new Map()

let _timer   = null
let _running = false   // prevents concurrent overlapping ticks

// ─── Public interface ─────────────────────────────────────────────────────────

export const monitorService = { start, stop, resetIdea }

// Called when an idea is moved back to 'looking' so the next tick checks it immediately
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

        // Surface any orders that were deferred while the market was closed.
        await _marketSweep(db)

        if (!ideas || ideas.length === 0) return
        logger.info(LOG, `Checking ${ideas.length} idea(s) (looking + long + short)`)

        // Process ideas sequentially to avoid hammering the Massive API
        for (const idea of ideas) {
            await _checkIdea(db, idea)
        }
    } finally {
        _running = false
    }
}

// ─── Deferred-order market sweep ───────────────────────────────────────────────

/**
 * Ideas that hit while the (equity) market was closed are parked in
 * orderState='awaiting_market'. Surface a deferred order once it can trade:
 * an equity idea when the regular session opens, a crypto idea immediately
 * (24/7). Crypto normally is born 'awaiting_confirm', but a crypto asset that
 * wasn't recognised at save time can land here — so we recover it regardless of
 * the equity session rather than leaving it stuck until the market opens.
 *
 * Phase 1 (manual mode): flip to 'awaiting_confirm' so the confirmation dialog
 * appears. Phase 2 will branch here on the user's orderMode to auto-place.
 */
async function _marketSweep(db) {
    let deferred
    try {
        deferred = await db.collection(COLLECTION).find({ orderState: 'awaiting_market' }).toArray()
    } catch (err) {
        logger.error(LOG, 'Market sweep read error:', err.message)
        return
    }
    if (!deferred || deferred.length === 0) return

    // Surface each deferred order once its own market opens (crypto 24/7, futures
    // near-24/5, equities at the RTH bell) — not just the equity session.
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

    const entryTf    = _resolveEntryTimeframe(idea)
    const isPosition = status === 'long' || status === 'short'
    const stopTf     = isPosition ? _resolveStopTimeframe(idea) : null
    const tpTf       = isPosition ? _resolveTpTimeframe(idea)   : null

    // Re-check cadence is driven by the *fastest* timeframe relevant to the
    // current phase. A 5min stop on a position entered from a daily chart must
    // still be checked ~every 5min, not every 4h.
    let gap = isPosition
        ? Math.min(getCheckGap(stopTf), getCheckGap(tpTf), getCheckGap(entryTf))
        : getCheckGap(entryTf)

    // A cumulative-volume leaf is evaluated intrabar — poll ~1-min regardless of the
    // phase timeframe so the running session total is caught near-live.
    const volPhases = isPosition
        ? [[idea.stop_condition_tree, idea.stop_conditions], [idea.tp_condition_tree, idea.tp_conditions]]
        : [[idea.entry_condition_tree, idea.entry_conditions]]
    const hasCumulativeVolume = volPhases.some(([t, f]) => _hasCumulativeVolume(t, f))
    if (hasCumulativeVolume) gap = Math.min(gap, 60_000)

    // Skip intraday ideas when their market is closed — there are no new bars and
    // evaluating would waste API calls. isAssetOpen handles each class: crypto is
    // 24/7, futures near-24/5, equities only in RTH. Daily+ timeframes still run.
    // A cumulative-volume leaf counts as intraday for this gate even on a daily
    // timeframe: the session total only accumulates while the market is open, so we
    // must NOT keep summing (or fire on the completed day's total) after the bell.
    const fastestTf = isPosition
        ? [stopTf, tpTf, entryTf].reduce((a, b) => getCheckGap(a) <= getCheckGap(b) ? a : b)
        : entryTf
    if ((isIntradayTimeframe(fastestTf) || hasCumulativeVolume) && !isAssetOpen(asset, idea.asset_class)) {
        logger.info(LOG, `[${id}] Market closed — skipping ${hasCumulativeVolume ? 'cumulative-volume' : 'intraday'} check (${asset}/${fastestTf})`)
        return
    }

    const lastAt = _lastChecked.get(id) ?? 0
    if (Date.now() - lastAt < gap) return

    // Note: _lastChecked is stamped only after a *successful* fetch+evaluate.
    // A transient candle-fetch failure leaves the clock untouched so the idea
    // is retried on the next poll tick rather than going dark for a full `gap`.
    try {
        if (status === 'looking') {
            const candles = await _fetchCandles(id, asset, entryTf)
            if (!candles) return
            _lastChecked.set(id, Date.now())
            _logCheck(id, asset, status, entryTf, candles)
            await _checkEntry(db, idea, candles)

        } else if (isPosition) {
            const stopCandles = await _fetchCandles(id, asset, stopTf)
            if (!stopCandles) return

            const tpCandles = tpTf === stopTf
                ? stopCandles
                : await _fetchCandles(id, asset, tpTf)
            if (!tpCandles) return

            // Additional entries scale into the position using entry-timeframe candles
            const aeCandles = entryTf === stopTf
                ? stopCandles
                : await _fetchCandles(id, asset, entryTf)
            if (!aeCandles) return

            _lastChecked.set(id, Date.now())
            _logCheck(id, asset, status, `stop=${stopTf}/tp=${tpTf}`, stopCandles)
            await _checkPosition(db, idea, stopCandles, tpCandles, aeCandles)
        }
    } catch (err) {
        logger.error(LOG, `Error processing idea ${id}:`, err.message)
    }
}

async function _fetchCandles(id, asset, tf, count = CANDLE_COUNT) {
    let candles
    try {
        candles = await getCandles(asset, tf, count)
    } catch (err) {
        logger.error(LOG, `Candle fetch error for ${asset}/${tf}:`, err.message)
        return null
    }
    if (!candles || candles.length < 5) {
        logger.warn(LOG, `Skipping idea ${id} — insufficient candles for ${asset}/${tf}`)
        return null
    }
    return candles
}

// ─── Cumulative-volume context ─────────────────────────────────────────────────

/**
 * Does a phase's conditions contain a `volume` leaf in cumulative mode? Such a leaf
 * is evaluated intrabar against 1-min bars summed from the session start, so it
 * drives both a faster check cadence and a separate 1-min fetch.
 */
function _hasCumulativeVolume(tree, flat) {
    const leaves = extractLeaves(tree)
    const all    = leaves.length ? leaves : (Array.isArray(flat) ? flat : [])
    return all.some(l => l && typeof l === 'object' && l.type === 'volume' && l.mode === 'cumulative')
}

/**
 * Build the ctx a cumulative-volume leaf needs: the session-start boundary and a
 * 1-min candle series long enough to cover from that boundary to now (crypto can run
 * ~1440 bars/day, so we size the fetch to the elapsed session, capped). Returns null
 * when the phase has no cumulative-volume leaf (the common case — no extra fetch).
 */
async function _buildVolumeCtx(id, asset, assetClass, tree, flat) {
    if (!_hasCumulativeVolume(tree, flat)) return null
    const start        = sessionStartMs(asset, assetClass)
    const minutesSince = Math.ceil((Date.now() - start) / 60_000)
    const count        = Math.min(1500, Math.max(5, minutesSince + 5))
    const minute       = await _fetchCandles(id, asset, '1min', count)
    if (!minute) {
        logger.warn(LOG, `[${id}] cumulative-volume: no 1-min candles for ${asset} — leaf will read false this tick`)
        return { sessionStartMs: start, minuteCandles: {} }
    }
    return { sessionStartMs: start, minuteCandles: { [asset]: minute } }
}

function _logCheck(id, asset, status, tf, candles) {
    const lastCandle = candles[candles.length - 1]
    const close = lastCandle?.c ?? '?'
    logger.info(LOG, `──── Check ${id} | ${asset} | status=${status} | tf=${tf} | close=${close}`)
}

// ─── Cross-asset symbol helpers ───────────────────────────────────────────────

/**
 * Build a symbolMap for an evaluation phase.
 * Fetches candles for every cross-asset symbol referenced in the conditions.
 * The default asset's candles are passed in and never re-fetched.
 */
async function _buildSymbolMap(id, defaultSymbol, defaultCandles, timeframe, crossSymbols) {
    const map = { [defaultSymbol]: defaultCandles }
    for (const sym of crossSymbols) {
        if (sym === defaultSymbol) continue
        const c = await _fetchCandles(id, sym, timeframe)
        if (c) {
            map[sym] = c
        } else {
            logger.warn(LOG, `[${id}] Cross-asset candles unavailable for ${sym}/${timeframe}`)
        }
    }
    return map
}

// ─── Entry phase ──────────────────────────────────────────────────────────────

async function _checkEntry(db, idea, candles) {
    const { id, asset } = idea
    const entryTf = _resolveEntryTimeframe(idea)

    const crossSyms = collectSymbols(idea.entry_condition_tree, idea.entry_conditions)
    const symbolMap = await _buildSymbolMap(id, asset, candles, entryTf, crossSyms)
    const volCtx    = await _buildVolumeCtx(id, asset, idea.asset_class, idea.entry_condition_tree, idea.entry_conditions)

    // Entry detection floor: only events at/after the idea's creation count
    // (entryFloorAt is set forward by the user's "reset window" action; otherwise
    // it's the idea's savedAt). This is what makes events that happened during the
    // 'waiting' window — before the user activated — still surface on activation.
    const floorAt = idea.entryFloorAt ?? idea.savedAt ?? null

    let triggered = false
    let triggerAt = null
    const entryStates = []   // per-leaf evaluated state → UI met marks

    if (idea.entry_condition_tree) {
        // New tree format
        logger.info(LOG, `[${id}] Evaluating entry condition tree`)
        ;({ triggered, triggerAt } = await evaluateTree(idea.entry_condition_tree, symbolMap, asset, floorAt, [], entryStates, volCtx))
    } else if (Array.isArray(idea.entry_conditions) && idea.entry_conditions.length > 0) {
        // Legacy flat-array format
        logger.info(LOG, `[${id}] Evaluating entry conditions (legacy flat format)`)
        const entryLogic = idea.entry_logic ?? 'AND'
        ;({ triggered, triggerAt } = await evaluateConditions(idea.entry_conditions, entryLogic, symbolMap, asset, floorAt))
    } else {
        logger.warn(LOG, `Idea ${id} has no entry conditions — skipping`)
        return
    }

    await _persistConditionStates(db, idea, 'entry', entryStates)

    if (triggered) {
        // Fired on an event that occurred before the user activated monitoring
        // (after creation, while still 'waiting'). The confirm dialog offers the
        // 3-choice path (confirm / reset window / dismiss) for these.
        const triggeredWhileWaiting = triggerAt != null && idea.activatedAt != null && triggerAt < idea.activatedAt
        if (triggeredWhileWaiting) {
            logger.info(LOG, `[${id}] Entry event predates activation (triggerAt=${triggerAt} < activatedAt=${idea.activatedAt}) — flagging triggeredWhileWaiting`)
        }

        const patch = { status: 'hit', entryTriggeredAt: Date.now() }
        if (triggeredWhileWaiting) {
            patch.triggeredWhileWaiting = true
            patch.triggerEventAt        = triggerAt
        }

        // Build the order plan server-side so it no longer depends on the browser.
        // Manual mode (phase 1): surface the confirm dialog when the market is open,
        // otherwise defer the decision until the next market open.
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
        // Orders are NOT placed automatically in manual mode. The user confirms via
        // the order confirmation dialog, which calls POST /trade-ideas/:id/orders.
    } else {
        logger.info(LOG, `⏳ Entry not triggered yet for idea ${id} (${asset})`)
    }
}

// ─── Position phase (stop / TP) ───────────────────────────────────────────────

async function _checkPosition(db, idea, stopCandles, tpCandles, aeCandles) {
    const { id, asset } = idea
    const stopTf  = _resolveStopTimeframe(idea)
    const tpTf    = _resolveTpTimeframe(idea)
    const entryTf = _resolveEntryTimeframe(idea)

    // ── Stop conditions ───────────────────────────────────────────────────────
    // The execution reconciler flips the idea closed when a native SL fills, so
    // exits the broker protects natively (monitor* === false) are skipped here.
    const stopFired = await _evaluateExit(db, idea, {
        phase: 'stop', candles: stopCandles, timeframe: stopTf,
        reason: 'stop', label: 'Stop', emoji: '🛑', native: idea.monitorStop,
    })
    if (stopFired) return

    // ── TP conditions ─────────────────────────────────────────────────────────
    const tpFired = await _evaluateExit(db, idea, {
        phase: 'tp', candles: tpCandles, timeframe: tpTf,
        reason: 'tp', label: 'TP', emoji: '🎯', native: idea.monitorTp,
    })
    if (tpFired) return

    logger.info(LOG, `💤 No exit triggered for idea ${id} (${asset}) — still in position`)

    // ── Additional entries (scale-in) ─────────────────────────────────────────
    await _checkAdditionalEntries(db, idea, aeCandles, entryTf)
}

/**
 * Evaluate one exit leg (stop or TP) for a position. When a condition fires it SENDS
 * the close order(s) to the broker (and lets the reconciler flip the idea closed on
 * the resulting fill); for an alert-only idea with no live position it falls back to
 * marking the idea closed. Returns true if anything fired this tick.
 *
 * A routed multi-level leg evaluates its RESIDUAL tree (only the non-price leaves —
 * the bare price touches are resting natively at the broker) child-by-child, so each
 * fires and closes just its own slice. A legacy / single monitored leg evaluates the
 * full tree and closes the whole remaining position.
 *
 * @param {{ phase:'stop'|'tp', candles:object[], timeframe:string,
 *           reason:'stop'|'tp', label:string, emoji:string, native:boolean|undefined }} opts
 */
async function _evaluateExit(db, idea, { phase, candles, timeframe, reason, label, emoji, native }) {
    const { id, asset } = idea

    // monitor* === false means the broker now protects this leg natively — skip it.
    if (native === false) {
        logger.info(LOG, `[${id}] ${label} handled natively by broker — skipping monitor ${reason} check`)
        return false
    }

    // Prefer the residual monitor tree (routed multi-level leg: only the non-price
    // leaves live here); fall back to the full leg tree (legacy / single monitored).
    const residual   = idea[`${phase}MonitorTree`] ?? null
    const tree       = residual ?? idea[`${phase}_condition_tree`]
    const conditions = idea[`${phase}_conditions`]
    const crossSyms  = collectSymbols(tree, conditions)
    const symbolMap  = await _buildSymbolMap(id, asset, candles, timeframe, crossSyms)
    const floorAt    = idea.activatedAt ?? null
    const volCtx     = await _buildVolumeCtx(id, asset, idea.asset_class, tree, conditions)

    if (residual) {
        return _evaluateResidual(db, idea, { phase, residual, symbolMap, asset, floorAt, reason, label, emoji, volCtx })
    }

    let triggered = false
    let which
    const states = []   // per-leaf evaluated state → UI met marks
    if (tree) {
        logger.info(LOG, `[${id}] Evaluating ${reason} condition tree`)
        ;({ triggered, which } = await evaluateTree(tree, symbolMap, asset, floorAt, [], states, volCtx))
    } else if (Array.isArray(conditions) && conditions.length > 0) {
        const logic = idea[`${phase}_logic`] ?? 'OR'
        ;({ triggered, which } = await evaluateConditions(conditions, logic, symbolMap, asset, floorAt))
    } else {
        logger.info(LOG, `[${id}] No ${reason} conditions defined — skipping ${reason} check`)
        return false
    }

    await _persistConditionStates(db, idea, phase, states)

    if (triggered) {
        logger.info(LOG, `${emoji} ${label} triggered for idea ${id}: "${(which ?? '').slice(0, 60)}"`)
        await _exitNow(db, idea, { leg: phase, reason, quantity: null })   // null ⇒ close full remaining
        return true
    }
    return false
}

/**
 * Evaluate a routed leg's residual tree child-by-child. The residual is an OR of the
 * leg's non-price leaves; each child carries its own quantity, so a fired child
 * closes just that slice. Fired children are remembered (firedExits) so a slice is
 * never closed twice across ticks.
 */
async function _evaluateResidual(db, idea, { phase, residual, symbolMap, asset, floorAt, reason, label, emoji, volCtx }) {
    const children = Array.isArray(residual.children) ? residual.children : []
    const fired    = new Set(idea.firedExits ?? [])
    let any = false

    for (let i = 0; i < children.length; i++) {
        const tag = `${phase}:${i}`
        if (fired.has(tag)) continue

        const child = children[i]
        const { triggered, which } = await evaluateTree(child, symbolMap, asset, floorAt, [], null, volCtx)
        if (!triggered) continue

        const qty = Number(child.quantity) || null
        logger.info(LOG, `${emoji} ${label} slice ${i} triggered for idea ${idea.id}: "${(which ?? child.condition ?? '').slice(0, 60)}" (qty ${qty ?? 'full'})`)
        await _exitNow(db, idea, { leg: phase, reason, quantity: qty, tag })
        any = true
    }
    return any
}

/**
 * Send the close order(s) for a fired monitored exit. Places an opposite-side MARKET
 * order per linked account (scaled to that account, clamped to its remaining size so
 * a netting position can never flip), records each as a working exit order so the
 * reconciler matches the fill, and remembers the fired child tag. An alert-only idea
 * (no live position) just gets marked closed, as before.
 * @param {{ leg:'stop'|'tp', reason:string, quantity:number|null, tag?:string }} opts
 */
async function _exitNow(db, idea, { leg, reason, quantity, tag }) {
    const links = (idea.brokerOrders ?? []).filter(b => b.positionId != null)

    if (links.length === 0) {
        await _close(db, idea.id, reason)   // alert-only idea — legacy DB-only close
        return
    }

    // A full close (quantity == null) closes the whole position directly: the broker
    // sizes it, so it works even for legacy ideas that never stored a per-account
    // entry quantity, and the reconciler flips the idea closed on the resulting fill.
    if (quantity == null) {
        for (const link of links) {
            try {
                await brokerService.closePosition(link.broker, idea.userId, link.accountId, link.positionId)
                logger.info(LOG, `[${idea.id}] Monitor close sent — ${leg} full position (acct ${link.accountId})`)
            } catch (err) {
                logger.error(LOG, `[${idea.id}] Monitor full close failed (acct ${link.accountId}): ${err.message}`)
            }
        }
        // Stamp the reason so the reconciler attributes the broker close (a market
        // close reports as 'manual') to this stop/tp instead.
        const update = { $set: { pendingCloseReason: reason } }
        if (tag) update.$addToSet = { firedExits: tag }
        await db.collection(COLLECTION).updateOne({ id: idea.id }, update)
        return
    }

    // A partial slice closes a sized opposite-side MARKET order per account (scaled,
    // clamped to remaining so a netting position can't flip), recorded so the
    // reconciler matches the fill.
    const totalQty  = Number(idea.quantity) || 0
    const newOrders = []
    for (const link of links) {
        const entryQty  = Number(link.quantity) || 0
        const factor    = (entryQty > 0 && totalQty > 0) ? entryQty / totalQty : 1
        const remaining = _remainingForAccount(idea, link.accountId)
        let qty = _round(quantity * factor)
        if (qty > remaining) qty = remaining
        if (!(qty > 0)) continue
        try {
            const res = await brokerService.placeOrder(link.broker, idea.userId, link.accountId, {
                symbol:    idea.brokerSymbol ?? idea.asset,
                direction: idea.direction === 'long' ? 'short' : 'long',
                quantity:  qty,
                type:      'market',
                ...(link.positionId != null && { positionId: link.positionId }),   // closing order
            })
            newOrders.push({
                accountId: String(link.accountId), broker: link.broker, leg,
                type: 'market', price: null, quantity: qty, positionId: link.positionId ?? null,
                orderId: res?.orderId != null ? String(res.orderId) : null,
                status: 'working', placedAt: Date.now(),
            })
            logger.info(LOG, `[${idea.id}] Monitor close sent — ${leg} ${qty} market (acct ${link.accountId})`)
        } catch (err) {
            logger.error(LOG, `[${idea.id}] Monitor close failed (acct ${link.accountId}): ${err.message}`)
        }
    }

    const update = {}
    if (newOrders.length) update.$push     = { exitOrders: { $each: newOrders } }
    if (tag)              update.$addToSet = { firedExits: tag }
    if (Object.keys(update).length) await db.collection(COLLECTION).updateOne({ id: idea.id }, update)
}

/**
 * Remaining open quantity (idea units) for an account: entry qty − filled exit
 * slices. Mirrors the reconciler's accounting (the reconciler marks slices filled).
 */
function _remainingForAccount(idea, accountId) {
    const acct     = String(accountId)
    const slot     = (idea.brokerOrders ?? []).find(b => String(b.accountId) === acct)
    const entryQty = Number(slot?.quantity) || 0
    const closed   = (idea.exitOrders ?? [])
        .filter(o => o.status === 'filled' && String(o.accountId) === acct)
        .reduce((s, o) => s + (Number(o.quantity) || 0), 0)
    return Math.max(0, _round(entryQty - closed))
}

const _round = n => Math.round((Number(n) || 0) * 10000) / 10000

async function _checkAdditionalEntries(db, idea, candles, entryTf) {
    const entries = idea.additional_entries
    if (!Array.isArray(entries) || entries.length === 0) return

    for (let i = 0; i < entries.length; i++) {
        const ae = entries[i]

        if (ae.filledAt) continue     // order confirmed filled — check the next entry
        if (ae.triggeredAt) break     // order queued but not yet filled — wait

        // first un-triggered entry: its predecessor (if any) is confirmed filled
        const crossSyms = collectSymbols(ae.condition_tree, ae.conditions)
        const symbolMap = await _buildSymbolMap(idea.id, idea.asset, candles, entryTf, crossSyms)

        let triggered = false
        if (ae.condition_tree) {
            ;({ triggered } = await evaluateTree(ae.condition_tree, symbolMap, idea.asset, idea.activatedAt ?? null))
        } else if (Array.isArray(ae.conditions) && ae.conditions.length > 0) {
            ;({ triggered } = await evaluateConditions(ae.conditions, ae.logic ?? 'AND', symbolMap, idea.asset, idea.activatedAt ?? null))
        } else {
            break
        }

        if (triggered) {
            logger.info(LOG, `📈 Additional entry ${i + 1} triggered for idea ${idea.id} — qty: ${ae.quantity}`)
            await db.collection(COLLECTION).updateOne(
                { id: idea.id },
                { $set: { [`additional_entries.${i}.triggeredAt`]: Date.now() } }
            )
        }
        break  // don't evaluate entry i+1 until this one is filled
    }
}

// ─── Timeframe helpers ────────────────────────────────────────────────────────

/**
 * Find the effective timeframe for one phase of an idea.
 * Checks the condition-tree's first leaf, then the legacy flat fields, then
 * a phase-specific fallback (lazy, so entry's resolution isn't computed unless needed).
 * @param {object} idea
 * @param {'entry'|'stop'|'tp'} phase
 * @param {() => string} fallback
 */
function _resolvePhaseTimeframe(idea, phase, fallback) {
    const tree = idea[`${phase}_condition_tree`]
    if (tree) {
        const leaf = firstLeaf(tree)
        if (leaf?.timeframe) return leaf.timeframe
    }
    return idea[`${phase}_conditions`]?.[0]?.timeframe
        ?? idea[`${phase}_timeframe`]
        ?? fallback()
}

const _resolveEntryTimeframe = idea => _resolvePhaseTimeframe(idea, 'entry', () => idea.timeframe ?? 'day')
const _resolveStopTimeframe  = idea => _resolvePhaseTimeframe(idea, 'stop',  () => _resolveEntryTimeframe(idea))
const _resolveTpTimeframe    = idea => _resolvePhaseTimeframe(idea, 'tp',    () => _resolveEntryTimeframe(idea))

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

/**
 * Persist per-leaf met state for one phase ('entry' | 'stop' | 'tp') so the UI can
 * mark conditions that have evaluated true. Merges with prior state: leaves not
 * reached this cycle (short-circuited) keep their previous mark, reached leaves
 * reflect the current pass/fail. Writes only when something changed (and mutates
 * the in-memory idea so a later phase in the same tick sees the update).
 */
async function _persistConditionStates(db, idea, phase, results) {
    if (!Array.isArray(results) || results.length === 0) return
    const prev = idea.conditionStates?.[phase] ?? {}
    const next = { ...prev }
    for (const r of results) {
        if (!r?.key) continue
        if (r.pass) next[r.key] = r.at ?? Date.now()
        else delete next[r.key]
    }
    if (JSON.stringify(next) === JSON.stringify(prev)) return
    await db.collection(COLLECTION).updateOne({ id: idea.id }, { $set: { [`conditionStates.${phase}`]: next } })
    idea.conditionStates = { ...(idea.conditionStates ?? {}), [phase]: next }
}
