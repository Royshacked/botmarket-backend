import { getDb }           from '../../providers/mongodb.provider.js'
import { logger }          from '../../services/logger.service.js'
import { monitorService }  from '../../monitoring/monitor.service.js'
import { brokerService }   from '../broker/broker.service.js'
import { buildOrderPlanForIdea, resolveUserAccounts } from '../../services/orderPlan.service.js'
import { routeExits, currentReferencePrice, detectNativeEntryLevel } from '../../services/protectionPlan.service.js'
import { isAssetOpen } from '../../services/market.service.js'
import { toBrokerSymbol, normSymbol } from '../../services/brokerSymbol.service.js'
import { resolveConditionTree, extractLeaves, topOperator, firstLeafTimeframe } from '../../services/conditionTree.service.js'

const LOG = '[idea]'
const COLLECTION = 'ideas'

const VALID_STATUSES = new Set(['waiting', 'looking', 'resting', 'hit', 'long', 'short', 'closed'])

// Broker *execution* order types — distinct from idea.type (the trade STYLE:
// intraday/swing/scalp/position). A confirmed entry is always placed at market;
// resting stop-market entries take their own path. Anything outside this set
// (incl. a trade-style leaking in, or a legacy plan that stored idea.type here)
// is coerced to 'market' before hitting the broker.
const ORDER_EXEC_TYPES = new Set(['market', 'limit', 'stop'])
const toExecType = t => (ORDER_EXEC_TYPES.has(t) ? t : 'market')

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
        // Instrument class set by the chat assistant ('stock'|'etf'|'futures'|
        // 'forex'|'crypto') — drives market-hours classification; null falls back
        // to the symbol heuristic in market.service.
        asset_class:     tradeIdea.asset_class     ?? null,
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
        // Asset-level (independent of accounts) — shared by every forked child.
        if (enriched.entryOrderType === 'stop') {
            const level = await detectNativeEntryLevel(enriched)
            if (level != null) {
                enriched.entryTriggerPrice = level
            } else {
                logger.warn(LOG, 'entry_order_type=stop but entry is not a bare price level — falling back to monitored', { asset: enriched.asset })
                enriched.entryOrderType = null
            }
        }

        // Fork a multi-broker idea into independent single-broker children — one per
        // distinct broker (accounts on the same broker stay together so balance-ratio
        // scaling still works). A single-broker / no-account idea yields exactly one
        // child with the original id. Children are linked only by groupId (display).
        const partitions = await _partitionByBroker(enriched, userId)
        const forked  = partitions.length > 1
        const groupId = forked ? `grp_${enriched.id}` : null

        const children = []
        for (let i = 0; i < partitions.length; i++) {
            const part  = partitions[i]
            const child = {
                ...enriched,
                id:            forked ? `${enriched.id}-${i + 1}` : enriched.id,
                accounts:      part.accountIds,
                mainAccountId: part.mainAccountId,
                groupId,
                // The broker this child trades on (known at fork time) — self-describing
                // for the UI (group labels) and any later per-broker logic.
                broker:        part.broker ?? null,
                // Resolve + persist the broker's tradable symbol once (no per-order
                // lookup). `asset` stays the canonical app name the monitor/Massive
                // feed use; brokerSymbol is what we send to the broker (NQ → US100).
                brokerSymbol:  part.broker ? toBrokerSymbol(part.broker, enriched.asset) : null,
            }

            // Immediate ideas are born 'hit' — build each child's order plan now
            // (server-side, its own accounts only) and park it for confirmation.
            // Orders are NOT placed automatically; the user confirms via POST.
            if (isImmediate) await _attachImmediatePlan(child)
            children.push(child)
        }

        const db = await getDb()
        await db.collection(COLLECTION).insertMany(children)
        logger.info(LOG, 'Idea saved', { id: enriched.id, asset: enriched.asset, immediate: isImmediate, forked, children: children.length })

        return { ok: true, idea: _strip(children[0]), ideas: children.map(_strip) }
    } catch (err) {
        logger.error(LOG, 'Failed to save idea', err)
        return { ok: false, error: err }
    }
}

/** Build + park an immediate idea's server-side order plan (mutates `idea`). */
async function _attachImmediatePlan(idea) {
    const plan = await buildOrderPlanForIdea(idea)
    if (plan.length > 0) {
        const open = isAssetOpen(idea.asset, idea.asset_class)
        idea.pendingOrder = { plan, builtAt: Date.now() }
        idea.orderState   = open ? 'awaiting_confirm' : 'awaiting_market'
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
        const existing = await db.collection(COLLECTION).findOne(
            { id },
            { projection: { userId: 1, status: 1, brokerOrders: 1, stop_condition_tree: 1, tp_condition_tree: 1 } },
        )
        if (!existing) return { ok: false, reason: 'not_found' }
        if (existing.userId && existing.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }

        // Editing an idea that's already IN A POSITION must never knock it out of
        // long/short — that would re-run entry detection and could place a SECOND
        // order. Keep the position status and re-arm its exits: bare price levels are
        // RESTED as native orders at the broker right now (LIMIT for tp, STOP for
        // stop, opposite side — they net the position down), and any non-price leaves
        // stay on the software monitor.
        const inPosition = existing.status === 'long' || existing.status === 'short'
        if (inPosition && patch.status !== 'closed') {
            if (patch.status != null && patch.status !== existing.status) {
                patch.status = existing.status
                delete patch.entryTriggeredAt   // not a fresh entry
                delete patch.monitorPhase
                delete patch.activatedAt
            }
            const editsExits = patch.stop_conditions !== undefined || patch.tp_conditions !== undefined
            if (editsExits) {
                const full   = await db.collection(COLLECTION).findOne({ id })
                const merged = { ...full, ...patch }

                // Self-heal the broker symbol (NQ=F → US100) so protection prices resolve.
                const broker = (full.brokerOrders ?? []).find(b => b.positionId != null)?.broker
                if (broker) { merged.brokerSymbol = toBrokerSymbol(broker, merged.asset); patch.brokerSymbol = merged.brokerSymbol }

                const route = await routeExits(merged)
                const { exitOrders, referenceQuote } = await _armExitsInPosition(merged, route)
                const totalQty = Number(merged.quantity) || 0

                patch.exitOrders = exitOrders
                patch.nativeExit = {
                    stop: route.stop.single != null ? [{ level: route.stop.single, quantity: totalQty }] : route.stop.nativeOrders,
                    tp:   route.tp.single   != null ? [{ level: route.tp.single,   quantity: totalQty }] : route.tp.nativeOrders,
                    referenceQuote: referenceQuote ?? null,
                }
                // Bare-price legs now rest as CLOSING orders at the broker → not monitored.
                // Only residual (non-price) leaves stay on the monitor.
                patch.monitorStop     = route.stop.monitorTree != null
                patch.monitorTp       = route.tp.monitorTree   != null
                patch.stopMonitorTree = route.stop.monitorTree
                patch.tpMonitorTree   = route.tp.monitorTree
                patch.firedExits      = []
                monitorService.resetIdea(id)
            }
        }

        // Deactivating a resting idea (resting → waiting): cancel the working order(s)
        // at the broker and clear the resting linkage, parking it back in waiting.
        if (existing.status === 'resting' && patch.status === 'waiting') {
            await _cancelRestingOrders({ id, status: 'resting', brokerOrders: existing.brokerOrders }, existing.userId ?? userId)
            patch.orderState      = null
            patch.brokerOrders    = null
            patch.restingPlacedAt = null
            monitorService.resetIdea(id)
        }

        // A triggered idea (hit) sent back to waiting. Two flavours, both clearing the
        // now-stale pending order:
        //   • Dismiss (default) — park it but leave the entry floor UNTOUCHED. If the user
        //     changes their mind and re-activates (waiting→looking), the still-true event
        //     re-fires to hit. The while-waiting flags are preserved so the re-hit shows
        //     the same 3-choice dialog.
        //   • Reset window (patch.resetWindow) — push the entry floor forward to now so the
        //     dismissed event can't re-fire; only *new* events after this count. Clears the
        //     while-waiting flags.
        if (existing.status === 'hit' && patch.status === 'waiting') {
            patch.entryTriggeredAt = null
            patch.pendingOrder     = null
            patch.orderState       = null
            if (patch.resetWindow === true) {
                patch.entryFloorAt          = Date.now()
                patch.triggeredWhileWaiting = false
                patch.triggerEventAt        = null
            }
            monitorService.resetIdea(id)
        }

        // Strip the control flag — it drives the branch above but is never persisted.
        delete patch.resetWindow

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

        // Self-heal the broker symbol from the canonical asset at placement (NQ=F →
        // US100). Ideas saved before a symbol-mapping fix carry a stale brokerSymbol,
        // so re-resolve and persist it rather than trust the stored value.
        if (plan[0]?.broker) idea.brokerSymbol = toBrokerSymbol(plan[0].broker, idea.asset)

        // Decide which exits can ride on the broker's native SL/TP (bare price
        // levels) vs stay on the software monitor. The price levels are
        // broker-agnostic; we attach them only to brokers that can protect
        // natively, and remember per placed order whether it covered stop / TP.
        // Route each exit leg: a lone bare price level → attached SL/TP (here);
        // a multi-level leg's price touches → native orders placed on position-open;
        // its non-price leaves → the software monitor. See routeExits().
        const route = await routeExits(idea)
        let refPrice = null
        if (route.stop.single != null || route.tp.single != null) {
            const anyMarket = plan.some(o => (o.type ?? idea.type ?? 'market') === 'market')
            if (anyMarket) refPrice = await currentReferencePrice(idea.asset, _refTimeframe(idea))
        }

        const results      = []
        const brokerOrders = []   // linkage the execution reconciler matches closes against
        const protections  = []   // { stopNative, tpNative } per successfully placed order
        for (const order of plan) {
            const type = toExecType(order.type)
            // brokerSymbol is the broker's tradable name (resolved at fork time); fall
            // back to the canonical asset for pre-fork ideas / non-aliased instruments.
            const brokerOrder = { symbol: idea.brokerSymbol ?? idea.asset, direction: idea.direction, quantity: order.quantity, type }
            let stopNative = false, tpNative = false

            try {
                // Attach a lone bare-price SL/TP only when the broker supports it. A native
                // SL/TP on a MARKET order also needs a reference price; skip (leave to the
                // monitor) if we couldn't fetch one rather than risk a malformed order.
                // Multi-level exits don't attach here — they're placed on open as orders.
                const isMarket  = type === 'market'
                const canAttach = !!brokerService.capabilities(order.broker)?.nativeProtection && (!isMarket || refPrice != null)
                if (canAttach) {
                    if (route.stop.single != null) { brokerOrder.stopLoss   = route.stop.single; stopNative = true }
                    if (route.tp.single   != null) { brokerOrder.takeProfit = route.tp.single;   tpNative   = true }
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
                    quantity:   order.quantity,               // per-account entry qty (idea units) for exit scaling
                })
                protections.push({ stopNative, tpNative })
            } catch (err) {
                logger.error(LOG, 'Order failed', { id, broker: order.broker, accountId: order.accountId, error: err.message })
                results.push({ accountId: order.accountId, ok: false, error: err.message })
            }
        }

        const anyPlaced = results.some(r => r.ok)
        if (!anyPlaced) return { ok: false, reason: 'all_failed', results }

        const now    = Date.now()
        const status = idea.direction === 'short' ? 'short' : 'long'
        const set    = {
            status, ordersPlacedAt: now, activatedAt: now, orderState: 'placed', brokerOrders,
            brokerSymbol: idea.brokerSymbol,   // persist the self-healed symbol for exits/feed/display
            ...(await _exitFields(idea, route, protections)),
        }
        if (route.stop.single != null || route.tp.single != null) {
            set.nativeProtection = { stop: route.stop.single, tp: route.tp.single }
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

        // Self-heal a stale/missing broker symbol from the canonical asset (NQ=F → US100).
        if (plan[0]?.broker) idea.brokerSymbol = toBrokerSymbol(plan[0].broker, idea.asset)

        // A stop order carries its own reference (the stop price), so a lone bare-price
        // SL/TP can attach without a current-price lookup — the adapter derives the distance.
        const route = await routeExits(idea)

        // The stop entry price is ABSOLUTE and rests on the broker's book. For an aliased
        // symbol whose price basis differs (NQ authored vs cTrader US100), hand the adapter
        // the canonical live quote so it shifts the trigger onto the broker's book.
        const referenceQuote = await _basisReferenceQuote(idea)

        const results      = []
        const brokerOrders = []   // linkage the reconciler matches the fill against (by orderId)
        const protections  = []
        for (const order of plan) {
            const brokerOrder = {
                symbol:    idea.brokerSymbol ?? idea.asset,
                direction: idea.direction,
                quantity:  order.quantity,
                type:      'stop',
                stopPrice: triggerPrice,
                ...(referenceQuote != null && { referenceQuote }),
            }
            let stopNative = false, tpNative = false
            try {
                const canAttach = !!brokerService.capabilities(order.broker)?.nativeProtection
                if (canAttach) {
                    if (route.stop.single != null) { brokerOrder.stopLoss   = route.stop.single; stopNative = true }
                    if (route.tp.single   != null) { brokerOrder.takeProfit = route.tp.single;   tpNative   = true }
                }
                const result = await brokerService.placeOrder(order.broker, userId, order.accountId, brokerOrder)
                logger.info(LOG, 'Resting entry placed', { id, broker: order.broker, accountId: order.accountId, stopPrice: triggerPrice, orderId: result?.orderId, stopNative, tpNative })
                results.push({ accountId: order.accountId, ok: true, orderId: result?.orderId ?? null })
                brokerOrders.push({
                    broker:     order.broker,
                    accountId:  result?.accountId ?? order.accountId,
                    orderId:    result?.orderId    ?? null,
                    positionId: null,            // backfilled when the stop fills
                    quantity:   order.quantity,  // per-account entry qty (idea units) for exit scaling
                })
                protections.push({ stopNative, tpNative })
            } catch (err) {
                logger.error(LOG, 'Resting entry failed', { id, broker: order.broker, accountId: order.accountId, error: err.message })
                results.push({ accountId: order.accountId, ok: false, error: err.message })
            }
        }

        if (!results.some(r => r.ok)) return { ok: false, reason: 'all_failed', results }

        const now = Date.now()
        const set = {
            status:            'resting',
            orderState:        'resting',
            restingPlacedAt:   now,
            entryTriggerPrice: triggerPrice,
            brokerOrders,
            brokerSymbol:      idea.brokerSymbol,   // persist the self-healed symbol
            ...(await _exitFields(idea, route, protections, referenceQuote)),
        }
        if (route.stop.single != null || route.tp.single != null) {
            set.nativeProtection = { stop: route.stop.single, tp: route.tp.single }
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
        if (result.ok) saved.push(...(result.ideas ?? [result.idea]))
        else logger.warn(LOG, 'Batch idea save failed', { asset: idea.asset, error: result.error })
    }

    logger.info(LOG, 'Batch saved', { portfolioId: pid, total: plan.ideas.length, saved: saved.length })
    return { ok: true, ideas: saved, portfolioId: pid }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Arm an idea's exits against its ALREADY-OPEN position(s) — used when a stop/TP is
 * added or edited while in a position. Each bare-price level is placed as a cTrader
 * CLOSING order (a LIMIT for tp / STOP for stop, opposite side, tagged with the
 * position's positionId). A closing order only reduces/closes THAT position — it
 * never opens an opposite one (safe on a hedging account), is capped at the position
 * size, and is auto-cancelled when the position closes. Supports multiple levels and
 * shows up in the edit-orders panel. Any prior working exit orders are cancelled
 * first. Non-price exits stay on the monitor (caller sets the residual trees).
 *
 * @param {object} idea   merged idea (asset/brokerSymbol/direction/quantity/brokerOrders/exitOrders)
 * @param {{stop:object, tp:object}} route  routeExits(idea) result
 * @returns {Promise<{ exitOrders: object[], referenceQuote: number|null }>}
 */
async function _armExitsInPosition(idea, route) {
    const totalQty       = Number(idea.quantity) || 0
    const referenceQuote = await _basisReferenceQuote(idea)

    // Cancel prior working exit orders (we're replacing the setup); keep as history.
    const kept = []
    for (const o of (idea.exitOrders ?? [])) {
        if (o.status === 'working' && o.orderId) {
            try { await brokerService.cancelOrder(o.broker, idea.userId, o.accountId, o.orderId) }
            catch (err) { logger.warn(LOG, `arm-exits: cancel prior order failed (${o.orderId}): ${err.message}`) }
            kept.push({ ...o, status: 'cancelled', cancelledAt: Date.now() })
        } else {
            kept.push(o)
        }
    }

    const legSpecs = [
        { leg: 'stop', type: 'stop',  single: route.stop.single, multi: route.stop.nativeOrders },
        { leg: 'tp',   type: 'limit', single: route.tp.single,   multi: route.tp.nativeOrders },
    ]
    // One set of exits per DISTINCT open position (dedupe duplicate slots).
    const seen = new Set()
    const openLinks = (idea.brokerOrders ?? []).filter(b => {
        if (b.positionId == null) return false
        const key = `${b.accountId}:${b.positionId}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
    const placed = []

    for (const link of openLinks) {
        const entryQty = Number(link.quantity) || totalQty   // legacy slots: assume full position
        const factor   = (entryQty > 0 && totalQty > 0) ? entryQty / totalQty : 1
        for (const spec of legSpecs) {
            const rawLevels = spec.single != null
                ? [{ level: spec.single, quantity: entryQty }]                          // single → full position
                : (spec.multi ?? []).map(l => ({ level: l.level, quantity: Math.round((Number(l.quantity) || 0) * factor * 10000) / 10000 }))
            // Dedupe by price so a repeated leaf can't place two identical orders.
            const levels = [...new Map(rawLevels.map(l => [l.level, l])).values()]
            for (const lvl of levels) {
                if (!(lvl.quantity > 0)) continue
                const order = {
                    symbol:     idea.brokerSymbol ?? idea.asset,
                    direction:  idea.direction === 'long' ? 'short' : 'long',   // close side
                    quantity:   lvl.quantity,
                    type:       spec.type,
                    positionId: link.positionId,                               // CLOSING order
                    ...(referenceQuote != null && { referenceQuote }),
                }
                if (spec.leg === 'tp') order.limitPrice = lvl.level
                else                   order.stopPrice  = lvl.level
                try {
                    const res = await brokerService.placeOrder(link.broker, idea.userId, link.accountId, order)
                    placed.push({
                        accountId: String(link.accountId), broker: link.broker, leg: spec.leg,
                        type: spec.type, price: lvl.level, quantity: lvl.quantity, positionId: link.positionId,
                        orderId: res?.orderId != null ? String(res.orderId) : null,
                        status: 'working', placedAt: Date.now(),
                    })
                    logger.info(LOG, `In-position exit placed for idea ${idea.id}: ${spec.leg} ${lvl.quantity} @ ${lvl.level} (pos ${link.positionId})`)
                } catch (err) {
                    logger.error(LOG, `In-position exit place failed (idea ${idea.id}, ${spec.leg} @ ${lvl.level}): ${err.message}`)
                }
            }
        }
    }
    return { exitOrders: [...kept, ...placed], referenceQuote }
}

/**
 * Build the exit-handling fields ($set) for an idea whose entry order(s) were just
 * placed, from the three routing buckets of routeExits():
 *   • single attached SL/TP  → monitor the leg only if some account couldn't attach
 *     natively (mixed broker support); the monitor then watches the full leg tree.
 *   • multi-level native orders → stored in `nativeExit`; the execution reconciler
 *     places them (LIMIT for tp, STOP for stop) when the position opens.
 *   • residual monitor tree  → stored as {leg}MonitorTree so the monitor watches
 *     only the non-price leaves (and never re-fires a level resting natively).
 *
 * monitorStop / monitorTp keep their meaning: true ⇒ the software monitor must still
 * watch that leg.
 *
 * @param {object} idea
 * @param {{stop:object, tp:object}} route          routeExits(idea) result
 * @param {{stopNative:boolean, tpNative:boolean}[]} protections  per placed entry order
 * @param {number|null} [referenceQuote]            basis shift for aliased native-exit
 *                                                  prices; computed lazily when omitted
 */
async function _exitFields(idea, route, protections, referenceQuote) {
    const out = {}

    for (const leg of ['stop', 'tp']) {
        const r        = route[leg]
        const flagKey  = leg === 'stop' ? 'monitorStop'     : 'monitorTp'
        const treeKey  = leg === 'stop' ? 'stopMonitorTree' : 'tpMonitorTree'
        const nativeOK = leg === 'stop' ? 'stopNative'      : 'tpNative'

        if (r.single != null) {
            // Lone bare-price level rides the attached SL/TP — monitor only the
            // accounts that couldn't attach it (mixed broker support).
            out[flagKey] = r.hasAny && protections.some(p => !p[nativeOK])
        } else {
            // Multi-level / non-price leg — the monitor watches just the residual.
            out[flagKey] = r.monitorTree != null
            if (r.monitorTree) out[treeKey] = r.monitorTree
        }
    }

    const nativeExit = {
        stop: route.stop.single == null ? route.stop.nativeOrders : [],
        tp:   route.tp.single   == null ? route.tp.nativeOrders   : [],
    }
    if (nativeExit.stop.length || nativeExit.tp.length) {
        const refQuote = referenceQuote !== undefined ? referenceQuote : await _basisReferenceQuote(idea)
        out.nativeExit = { ...nativeExit, referenceQuote: refQuote ?? null }
    }
    return out
}

/**
 * Partition an idea's accounts by broker, for forking a multi-broker idea into
 * independent single-broker children. Resolves each account id → broker, then
 * groups. Returns one partition per distinct broker; a single broker (or an
 * unresolvable/empty account set) yields exactly one partition with all the ids,
 * so the common case never forks. Each partition keeps the global main account
 * when it owns it, else lets the order planner pick its own main (ratio base).
 *
 * @returns {Promise<Array<{ broker: string|null, accountIds: string[], mainAccountId: string|null }>>}
 */
async function _partitionByBroker(idea, userId) {
    const accountIds = (idea.accounts ?? []).map(a => String(typeof a === 'object' ? a.id : a))
    const globalMain = idea.mainAccountId != null ? String(idea.mainAccountId) : null
    if (accountIds.length === 0) return [{ broker: null, accountIds: [], mainAccountId: globalMain }]

    const brokerById = new Map()
    try {
        const resolved = await resolveUserAccounts(userId, accountIds)
        for (const [id, acct] of resolved) brokerById.set(id, acct.broker)
    } catch (err) {
        // Can't reach the broker(s) — don't fork; the idea keeps all its accounts.
        logger.warn(LOG, `fork: account→broker resolve failed, not forking: ${err.message}`)
        return [{ broker: null, accountIds, mainAccountId: globalMain }]
    }

    const { partitions, unresolved } = _groupByBroker(accountIds, brokerById, globalMain)
    if (unresolved.length) logger.warn(LOG, 'fork: dropping accounts with no resolved broker', { ids: unresolved })
    return partitions
}

/**
 * Pure grouping of account ids by broker (testable; no I/O).
 * @param {string[]} accountIds
 * @param {Map<string,string>} brokerById  id → broker (missing = unresolved)
 * @param {string|null} globalMain
 * @returns {{ partitions: Array<{broker,accountIds,mainAccountId}>, unresolved: string[] }}
 */
export function _groupByBroker(accountIds, brokerById, globalMain) {
    const byBroker = new Map()
    for (const id of accountIds) {
        const broker = brokerById.get(id) ?? null
        if (!byBroker.has(broker)) byBroker.set(broker, [])
        byBroker.get(broker).push(id)
    }

    const known = [...byBroker.keys()].filter(b => b != null)
    // 0 or 1 distinct broker → don't fork; keep every account (incl. any unresolved).
    if (known.length <= 1) {
        return {
            partitions: [{ broker: known[0] ?? null, accountIds, mainAccountId: globalMain }],
            unresolved: [],
        }
    }

    // ≥2 brokers → one child each. Unresolved accounts can't be placed, so drop them.
    const partitions = known.map(broker => {
        const ids = byBroker.get(broker)
        return { broker, accountIds: ids, mainAccountId: ids.includes(globalMain) ? globalMain : null }
    })
    return { partitions, unresolved: byBroker.get(null) ?? [] }
}

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

/**
 * Canonical (Massive-feed) live quote for the cTrader boundary price shift, or null.
 * Only returned when the idea's broker symbol is aliased to a different price basis
 * (e.g. NQ→US100); for an identity symbol the broker and app prices match, so no
 * shift is needed and we skip the quote fetch entirely. A missing quote returns null
 * (the adapter then places at the authored price — logged, no basis shift).
 */
async function _basisReferenceQuote(idea) {
    const aliased = idea.brokerSymbol && normSymbol(idea.brokerSymbol) !== normSymbol(idea.asset)
    if (!aliased) return null
    const quote = await currentReferencePrice(idea.asset, _refTimeframe(idea))
    if (quote == null) logger.warn(LOG, 'basis shift: no canonical quote — placing at authored price', { asset: idea.asset, brokerSymbol: idea.brokerSymbol })
    return quote
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
