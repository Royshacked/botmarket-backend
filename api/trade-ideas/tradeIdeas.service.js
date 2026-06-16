import { getDb }           from '../../providers/mongodb.provider.js'
import { logger }          from '../../services/logger.service.js'
import { monitorService }  from '../../monitoring/monitor.service.js'
import { brokerService }   from '../broker/broker.service.js'
import { buildOrderPlanForIdea } from '../../services/orderPlan.service.js'
import { detectNativeLevels, currentReferencePrice, detectNativeEntryLevel } from '../../services/protectionPlan.service.js'
import { isMarketOpen, isCrypto } from '../../services/market.service.js'
import { resolveConditionTree, extractLeaves, topOperator, firstLeafTimeframe } from '../../services/conditionTree.service.js'

const LOG = '[idea]'
const COLLECTION = 'ideas'

const VALID_STATUSES = new Set(['waiting', 'looking', 'resting', 'hit', 'long', 'short', 'closed'])

export const ideaService = {
    saveIdea,
    saveBatchIdeas,
    getIdeas,
    getIdeaById,
    deleteIdea,
    updateIdea,
    placeOrdersForIdea,
}

async function saveIdea(tradeIdea, userId) {
    // Resolve condition trees from either new tree format or legacy flat arrays
    const entryTree = resolveConditionTree(tradeIdea.entry_condition,  tradeIdea.entry_conditions, tradeIdea.entry_logic ?? 'AND')
    const stopTree  = resolveConditionTree(tradeIdea.stop_loss,        tradeIdea.stop_conditions,  tradeIdea.stop_logic  ?? 'OR')
    const tpTree    = resolveConditionTree(tradeIdea.take_profit,      tradeIdea.tp_conditions,    tradeIdea.tp_logic    ?? 'OR')

    const additionalEntries = (tradeIdea.additional_entries ?? []).map(ae => {
        const tree = resolveConditionTree(ae.condition_tree, ae.conditions, ae.logic ?? 'AND')
        return {
            condition_tree: tree ?? null,
            conditions:     extractLeaves(tree),
            logic:          ae.logic ?? 'AND',
            quantity:       ae.quantity != null ? Number(ae.quantity) : null,
            triggeredAt:    null,
            filledAt:       null,
        }
    })

    const isImmediate = tradeIdea.immediate === true

    const enriched = {
        id:              String(Date.now()),
        savedAt:         Date.now(),
        status:          isImmediate ? 'hit' : 'waiting',
        entryTriggeredAt: isImmediate ? Date.now() : undefined,
        immediate:       isImmediate || undefined,
        asset:           tradeIdea.asset           ?? tradeIdea.ticker ?? '',
        direction:       tradeIdea.direction       ?? null,
        type:            tradeIdea.type            ?? null,
        quantity:        tradeIdea.quantity        != null ? Number(tradeIdea.quantity) : null,

        // Resting broker-native entry: a pure price-touch entry the broker holds as a
        // working STOP order (no software monitoring). entryTriggerPrice is resolved
        // from the bare price-level entry condition below; null entryOrderType = the
        // normal monitored/market path.
        entryOrderType:    tradeIdea.entry_order_type === 'stop' ? 'stop' : null,
        entryTriggerPrice: null,

        entry_timeframe: tradeIdea.entry_timeframe ?? null,
        stop_timeframe:  tradeIdea.stop_timeframe  ?? null,
        tp_timeframe:    tradeIdea.tp_timeframe    ?? null,

        // Tree format — primary source for the monitor
        entry_condition_tree: entryTree  ?? null,
        stop_condition_tree:  stopTree   ?? null,
        tp_condition_tree:    tpTree     ?? null,

        // Flat format — backward compat and display
        entry_conditions: extractLeaves(entryTree),
        entry_logic:      topOperator(entryTree) ?? 'AND',
        stop_conditions:  extractLeaves(stopTree),
        stop_logic:       topOperator(stopTree)  ?? 'OR',
        tp_conditions:    extractLeaves(tpTree),
        tp_logic:         topOperator(tpTree)    ?? 'OR',

        additional_entries: additionalEntries,
        notes:      tradeIdea.notes      ?? null,
        chat_state: tradeIdea.chat_state ?? null,
        accounts:      Array.isArray(tradeIdea.accounts) ? tradeIdea.accounts : [],
        mainAccountId: tradeIdea.mainAccountId ?? null,
        userId:        userId               ?? null,
        portfolioId:     tradeIdea.portfolioId     ?? undefined,
        portfolioName:   tradeIdea.portfolioName   ?? undefined,
        allocationRatio: tradeIdea.allocationRatio ?? undefined,
    }

    try {
        // Resting entry: resolve the trigger price from the bare price-level entry
        // condition. If the entry isn't a single price touch we can't rest it at the
        // broker, so fall back to the monitored path rather than persist a broken flag.
        if (enriched.entryOrderType === 'stop') {
            const level = await detectNativeEntryLevel(enriched)
            if (level != null) {
                enriched.entryTriggerPrice = level
            } else {
                logger.warn(LOG, 'entry_order_type=stop but entry is not a bare price level — falling back to monitored', { asset: enriched.asset })
                enriched.entryOrderType = null
            }
        }

        // Immediate ideas are born 'hit' — build the order plan now (server-side)
        // and park it for confirmation. Orders are NOT placed automatically in
        // manual mode; the user confirms via POST /trade-ideas/:id/orders.
        if (isImmediate) {
            const plan = await buildOrderPlanForIdea(enriched)
            if (plan.length > 0) {
                const open = isCrypto(enriched.asset) || isMarketOpen()
                enriched.pendingOrder = { plan, builtAt: Date.now() }
                enriched.orderState   = open ? 'awaiting_confirm' : 'awaiting_market'
            }
        }

        const db = await getDb()
        await db.collection(COLLECTION).insertOne(enriched)
        logger.info(LOG, 'Idea saved', { id: enriched.id, asset: enriched.asset, immediate: isImmediate, orderState: enriched.orderState })

        return { ok: true, idea: _strip(enriched) }
    } catch (err) {
        logger.error(LOG, 'Failed to save idea', err)
        return { ok: false, error: err }
    }
}

async function getIdeaById(id, userId, isAdmin = false) {
    try {
        const db   = await getDb()
        const idea = await db.collection(COLLECTION).findOne({ id })
        if (!idea) return { ok: false, reason: 'not_found' }
        if (idea.userId && idea.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }
        return { ok: true, idea: _strip(idea) }
    } catch (err) {
        logger.error(LOG, 'Failed to get idea by id', err)
        return { ok: false, error: err }
    }
}

async function getIdeas(userId, isAdmin = false) {
    try {
        const db = await getDb()
        const query = isAdmin ? {} : { userId }
        const items = await db.collection(COLLECTION).find(query).sort({ savedAt: -1 }).toArray()
        return items.map(_strip)
    } catch (err) {
        logger.error(LOG, 'Failed to get ideas', err)
        return []
    }
}

async function deleteIdea(id, userId, isAdmin = false) {
    try {
        const db = await getDb()
        const idea = await db.collection(COLLECTION).findOne({ id })
        if (!idea) return { ok: false, reason: 'not_found' }
        if (idea.userId && idea.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }

        // Pull any working resting entry off the broker before removing the idea, so
        // a deleted idea never leaves an order in the air. Best-effort; uses the
        // owner's broker session.
        await _cancelRestingOrders(idea, idea.userId ?? userId)

        await db.collection(COLLECTION).deleteOne({ id })
        logger.info(LOG, 'Idea deleted', { id })
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to delete idea', err)
        return { ok: false, error: err }
    }
}

async function updateIdea(id, patch, userId, isAdmin = false) {
    if (patch.status !== undefined && !VALID_STATUSES.has(patch.status)) {
        return { ok: false, reason: 'invalid_status' }
    }

    // Activating a resting (broker-native stop-market) entry isn't a plain status
    // write — it places the working order at the broker. Delegate to that flow.
    if (patch.status === 'resting') {
        return placeRestingEntryForIdea(id, userId, isAdmin)
    }

    // Rebuild condition trees when conditions are updated via chat edit
    if (patch.entry_conditions !== undefined || patch.stop_conditions !== undefined || patch.tp_conditions !== undefined) {
        const entryTree = resolveConditionTree(patch.entry_condition_tree, patch.entry_conditions, patch.entry_logic ?? 'AND')
        const stopTree  = resolveConditionTree(patch.stop_condition_tree,  patch.stop_conditions,  patch.stop_logic  ?? 'OR')
        const tpTree    = resolveConditionTree(patch.tp_condition_tree,    patch.tp_conditions,    patch.tp_logic    ?? 'OR')
        if (entryTree) { patch.entry_condition_tree = entryTree; patch.entry_conditions = extractLeaves(entryTree) }
        if (stopTree)  { patch.stop_condition_tree  = stopTree;  patch.stop_conditions  = extractLeaves(stopTree)  }
        if (tpTree)    { patch.tp_condition_tree    = tpTree;    patch.tp_conditions    = extractLeaves(tpTree)    }
    }

    // Clear conversation when idea is closed
    if (patch.status === 'closed') patch.chat_state = null

    // Moving back to looking always restarts entry monitoring from scratch
    if (patch.status === 'looking') {
        patch.monitorPhase     = 'entry'
        patch.entryTriggeredAt = null
        patch.activatedAt      = Date.now()
        monitorService.resetIdea(id)
    }

    // Activating a no-condition idea straight to 'hit' (e.g. portfolio activation)
    // — stamp the trigger time so the confirmation dialog shows when it fired.
    if (patch.status === 'hit') {
        patch.entryTriggeredAt = Date.now()
    }

    try {
        const db = await getDb()

        // Ownership check + current status/orders (drive the dismiss & resting-cancel
        // transitions below)
        const existing = await db.collection(COLLECTION).findOne({ id }, { projection: { userId: 1, status: 1, brokerOrders: 1 } })
        if (!existing) return { ok: false, reason: 'not_found' }
        if (existing.userId && existing.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }

        // Deactivating a resting idea (resting → waiting): cancel the working order(s)
        // at the broker and clear the resting linkage, parking it back in waiting.
        if (existing.status === 'resting' && patch.status === 'waiting') {
            await _cancelRestingOrders({ id, status: 'resting', brokerOrders: existing.brokerOrders }, existing.userId ?? userId)
            patch.orderState      = null
            patch.brokerOrders    = null
            patch.restingPlacedAt = null
            monitorService.resetIdea(id)
        }

        // Dismiss: a triggered idea (hit) is sent back to waiting. Park it and push
        // the entry floor forward to now so the just-dismissed event can't immediately
        // re-fire when the user re-activates (which would loop hit→dismiss forever).
        // Clear the pending order + trigger flags. Re-activation (waiting→looking) then
        // looks forward from here while still flagging any *new* while-waiting events.
        if (existing.status === 'hit' && patch.status === 'waiting') {
            patch.entryFloorAt          = Date.now()
            patch.entryTriggeredAt      = null
            patch.triggeredWhileWaiting = false
            patch.triggerEventAt        = null
            patch.pendingOrder          = null
            patch.orderState            = null
            monitorService.resetIdea(id)
        }

        // Atomic update — ownership constraint also in the filter eliminates the
        // TOCTOU window between the check above and the write below.
        const updateFilter = isAdmin || !existing.userId
            ? { id }
            : { id, userId }

        const result = await db.collection(COLLECTION).findOneAndUpdate(
            updateFilter,
            { $set: patch },
            { returnDocument: 'after' }
        )
        if (!result) return { ok: false, reason: 'not_found' }
        logger.info(LOG, 'Idea updated', { id, patch })
        return { ok: true, idea: _strip(result) }
    } catch (err) {
        logger.error(LOG, 'Failed to update idea', err)
        return { ok: false, error: err }
    }
}

/**
 * Place broker orders for a triggered ('hit') idea after the user confirms.
 *
 * `orders` is the explicit list the user confirmed in the dialog — each
 * { broker, accountId, quantity, type? }. We place exactly these (every call
 * runs through the user's own broker session, so accounts that aren't theirs
 * fail at the broker). On at least one success the idea advances to long/short
 * so stop/TP monitoring begins.
 */
async function placeOrdersForIdea(id, orders, userId, isAdmin = false) {
    try {
        const db   = await getDb()
        const idea = await db.collection(COLLECTION).findOne({ id })
        if (!idea) return { ok: false, reason: 'not_found' }
        if (idea.userId && idea.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }
        if (idea.status !== 'hit')  return { ok: false, reason: 'not_hit' }
        if (idea.ordersPlacedAt)    return { ok: false, reason: 'already_placed' }

        // Prefer the server-built plan stored on the idea; fall back to the
        // client-sent orders for ideas saved before plans were persisted.
        const plan = (idea.pendingOrder?.plan?.length) ? idea.pendingOrder.plan : orders
        if (!Array.isArray(plan) || plan.length === 0) return { ok: false, reason: 'no_orders' }

        // Decide which exits can ride on the broker's native SL/TP (bare price
        // levels) vs stay on the software monitor. The price levels are
        // broker-agnostic; we attach them only to brokers that can protect
        // natively, and remember per placed order whether it covered stop / TP.
        const levels = await detectNativeLevels(idea)
        let refPrice = null
        if (levels.stopLevel != null || levels.tpLevel != null) {
            const anyMarket = plan.some(o => (o.type ?? idea.type ?? 'market') === 'market')
            if (anyMarket) refPrice = await currentReferencePrice(idea.asset, _refTimeframe(idea))
        }

        const results      = []
        const brokerOrders = []   // linkage the execution reconciler matches closes against
        const protections  = []   // { stopNative, tpNative } per successfully placed order
        for (const order of plan) {
            const type = order.type ?? idea.type ?? 'market'
            const brokerOrder = { symbol: idea.asset, direction: idea.direction, quantity: order.quantity, type }
            let stopNative = false, tpNative = false

            try {
                // Attach native SL/TP only when the broker supports it. A native SL/TP on
                // a MARKET order also needs a reference price; skip (leave to the monitor)
                // if we couldn't fetch one rather than risk a malformed order. Inside the
                // try so an unknown broker fails only its own order, as before.
                const isMarket  = type === 'market'
                const canAttach = !!brokerService.capabilities(order.broker)?.nativeProtection && (!isMarket || refPrice != null)
                if (canAttach) {
                    if (levels.stopLevel != null) { brokerOrder.stopLoss   = levels.stopLevel; stopNative = true }
                    if (levels.tpLevel   != null) { brokerOrder.takeProfit = levels.tpLevel;   tpNative   = true }
                    if ((stopNative || tpNative) && isMarket) brokerOrder.referencePrice = refPrice
                }

                const result = await brokerService.placeOrder(order.broker, userId, order.accountId, brokerOrder)
                logger.info(LOG, 'Order placed', { id, broker: order.broker, accountId: order.accountId, direction: idea.direction, quantity: order.quantity, orderId: result?.orderId, stopNative, tpNative })
                results.push({ accountId: order.accountId, ok: true, orderId: result?.orderId ?? null })
                brokerOrders.push({
                    broker:     order.broker,
                    // Prefer the broker-canonical id (what execution events carry); fall
                    // back to the requested id for adapters that don't return one yet.
                    accountId:  result?.accountId ?? order.accountId,
                    orderId:    result?.orderId    ?? null,
                    positionId: result?.positionId ?? null,   // backfilled on the fill event
                })
                protections.push({ stopNative, tpNative })
            } catch (err) {
                logger.error(LOG, 'Order failed', { id, broker: order.broker, accountId: order.accountId, error: err.message })
                results.push({ accountId: order.accountId, ok: false, error: err.message })
            }
        }

        const anyPlaced = results.some(r => r.ok)
        if (!anyPlaced) return { ok: false, reason: 'all_failed', results }

        // Keep monitoring an exit unless EVERY placed order offloaded it natively —
        // a mixed idea (one native account, one not) must still watch for the
        // non-native account. The execution reconciler handles native closes.
        const monitorStop = levels.hasStop && protections.some(p => !p.stopNative)
        const monitorTp   = levels.hasTp   && protections.some(p => !p.tpNative)

        const now    = Date.now()
        const status = idea.direction === 'short' ? 'short' : 'long'
        const set    = { status, ordersPlacedAt: now, activatedAt: now, orderState: 'placed', brokerOrders, monitorStop, monitorTp }
        if (levels.stopLevel != null || levels.tpLevel != null) {
            set.nativeProtection = { stop: levels.stopLevel, tp: levels.tpLevel }
        }
        const updated = await db.collection(COLLECTION).findOneAndUpdate(
            { id },
            { $set: set },
            { returnDocument: 'after' }
        )

        // Keep each placed account's execution feed live so native stop/TP closes
        // reconcile back to this idea. Best-effort — a feed failure must not fail the
        // user's confirmed order.
        for (const { broker, accountId } of brokerOrders) {
            brokerService.startExecutionFeed(broker, userId, accountId)
                .catch(err => logger.warn(LOG, `startExecutionFeed failed (${broker}/${accountId}):`, err.message))
        }
        logger.info(LOG, 'Orders confirmed & placed', { id, status, placed: results.filter(r => r.ok).length })
        return { ok: true, idea: _strip(updated), results }
    } catch (err) {
        logger.error(LOG, 'Failed to place orders for idea', err)
        return { ok: false, error: err }
    }
}

/**
 * Activate a resting (broker-native stop-market) entry: place a working STOP order
 * at the trigger price on each account, with native SL/TP attached where supported.
 * The idea moves to 'resting' — the broker holds the order, no software monitoring.
 * When it fills, the execution reconciler flips it to long/short and stop/TP
 * monitoring begins (for any exit the broker isn't protecting natively).
 */
async function placeRestingEntryForIdea(id, userId, isAdmin = false) {
    try {
        const db   = await getDb()
        const idea = await db.collection(COLLECTION).findOne({ id })
        if (!idea) return { ok: false, reason: 'not_found' }
        if (idea.userId && idea.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }
        if (idea.entryOrderType !== 'stop')              return { ok: false, reason: 'not_resting' }
        if (idea.ordersPlacedAt || idea.restingPlacedAt) return { ok: false, reason: 'already_placed' }

        const triggerPrice = idea.entryTriggerPrice ?? await detectNativeEntryLevel(idea)
        if (triggerPrice == null) return { ok: false, reason: 'no_trigger_price' }

        const plan = await buildOrderPlanForIdea(idea)
        if (!Array.isArray(plan) || plan.length === 0) return { ok: false, reason: 'no_accounts' }

        // A stop order carries its own reference (the stop price), so native SL/TP can
        // attach without a current-price lookup — the adapter derives the distance.
        const levels = await detectNativeLevels(idea)

        const results      = []
        const brokerOrders = []   // linkage the reconciler matches the fill against (by orderId)
        const protections  = []
        for (const order of plan) {
            const brokerOrder = {
                symbol:    idea.asset,
                direction: idea.direction,
                quantity:  order.quantity,
                type:      'stop',
                stopPrice: triggerPrice,
            }
            let stopNative = false, tpNative = false
            try {
                const canAttach = !!brokerService.capabilities(order.broker)?.nativeProtection
                if (canAttach) {
                    if (levels.stopLevel != null) { brokerOrder.stopLoss   = levels.stopLevel; stopNative = true }
                    if (levels.tpLevel   != null) { brokerOrder.takeProfit = levels.tpLevel;   tpNative   = true }
                }
                const result = await brokerService.placeOrder(order.broker, userId, order.accountId, brokerOrder)
                logger.info(LOG, 'Resting entry placed', { id, broker: order.broker, accountId: order.accountId, stopPrice: triggerPrice, orderId: result?.orderId, stopNative, tpNative })
                results.push({ accountId: order.accountId, ok: true, orderId: result?.orderId ?? null })
                brokerOrders.push({
                    broker:     order.broker,
                    accountId:  result?.accountId ?? order.accountId,
                    orderId:    result?.orderId    ?? null,
                    positionId: null,   // backfilled when the stop fills
                })
                protections.push({ stopNative, tpNative })
            } catch (err) {
                logger.error(LOG, 'Resting entry failed', { id, broker: order.broker, accountId: order.accountId, error: err.message })
                results.push({ accountId: order.accountId, ok: false, error: err.message })
            }
        }

        if (!results.some(r => r.ok)) return { ok: false, reason: 'all_failed', results }

        const monitorStop = levels.hasStop && protections.some(p => !p.stopNative)
        const monitorTp   = levels.hasTp   && protections.some(p => !p.tpNative)

        const now = Date.now()
        const set = {
            status:            'resting',
            orderState:        'resting',
            restingPlacedAt:   now,
            entryTriggerPrice: triggerPrice,
            brokerOrders,
            monitorStop,
            monitorTp,
        }
        if (levels.stopLevel != null || levels.tpLevel != null) {
            set.nativeProtection = { stop: levels.stopLevel, tp: levels.tpLevel }
        }
        const updated = await db.collection(COLLECTION).findOneAndUpdate({ id }, { $set: set }, { returnDocument: 'after' })

        // Keep each account's execution feed live so the stop fill reconciles back
        // (resting → long/short). Best-effort — a feed failure must not fail placement.
        for (const { broker, accountId } of brokerOrders) {
            brokerService.startExecutionFeed(broker, userId, accountId)
                .catch(err => logger.warn(LOG, `startExecutionFeed failed (${broker}/${accountId}):`, err.message))
        }
        logger.info(LOG, 'Resting entry order(s) working at broker', { id, placed: results.filter(r => r.ok).length })
        return { ok: true, idea: _strip(updated), results }
    } catch (err) {
        logger.error(LOG, 'Failed to place resting entry', err)
        return { ok: false, error: err }
    }
}

async function saveBatchIdeas(plan, userId, accounts = [], mainAccountId = null, portfolioId = null) {
    // Reuse the given portfolioId when updating an existing plan; otherwise mint one.
    const pid   = portfolioId || `portfolio_${Date.now()}`
    const saved = []

    for (const idea of plan.ideas) {
        const result = await saveIdea({
            asset:           idea.asset,
            direction:       idea.direction,
            type:            idea.type,
            quantity:        idea.quantity,
            notes:           idea.notes,
            allocationRatio: idea.allocationRatio,
            // Portfolio ideas carry no conditions for now — they start as 'waiting'
            // and are activated (→ 'hit') via the plan row's status toggle.
            portfolioId:     pid,
            portfolioName:   plan.name,
            accounts,
            mainAccountId,
        }, userId)
        if (result.ok) saved.push(result.idea)
        else logger.warn(LOG, 'Batch idea save failed', { asset: idea.asset, error: result.error })
    }

    logger.info(LOG, 'Batch saved', { portfolioId: pid, total: plan.ideas.length, saved: saved.length })
    return { ok: true, ideas: saved, portfolioId: pid }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Best-effort cancel of a resting idea's working (unfilled) entry orders. Orders that
 * already filled carry a positionId (the reconciler stamped it) and are left alone —
 * those are real positions, not orders in the air. Failures are logged, not thrown,
 * so a delete/deactivate isn't blocked by a broker hiccup.
 */
async function _cancelRestingOrders(idea, userId) {
    if (idea?.status !== 'resting' || !Array.isArray(idea.brokerOrders)) return
    for (const link of idea.brokerOrders) {
        if (!link?.orderId || link.positionId != null) continue
        try {
            await brokerService.cancelOrder(link.broker, userId, link.accountId, link.orderId)
            logger.info(LOG, 'Resting order cancelled', { id: idea.id, broker: link.broker, accountId: link.accountId, orderId: link.orderId })
        } catch (err) {
            logger.warn(LOG, 'Resting order cancel failed', { id: idea.id, orderId: link.orderId, error: err.message })
        }
    }
}

// Timeframe to price a native-protection reference off — the entry timeframe,
// falling back to daily. Only used to fetch a current price near entry.
function _refTimeframe(idea) {
    return firstLeafTimeframe(idea.entry_condition_tree)
        ?? idea.entry_timeframe
        ?? idea.timeframe
        ?? 'day'
}

// strip MongoDB's internal _id before sending to client
function _strip(doc) {
    if (!doc) return doc
    const { _id, ...rest } = doc
    return rest
}
