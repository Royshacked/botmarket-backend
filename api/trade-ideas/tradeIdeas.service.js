import { randomUUID }       from 'crypto'
import { getDb, stripId }  from '../../providers/mongodb.provider.js'
import { logger }          from '../../services/logger.service.js'
import { minosService }     from '../../monitoring/minos.monitor.service.js'
import { brokerService }   from '../broker/broker.service.js'
import { buildOrderPlanForIdea, resolveUserAccounts } from '../../services/orderPlan.service.js'
import { routeExits, currentReferencePrice, detectNativeEntryLevel } from '../../services/protectionPlan.service.js'
import { isAssetOpen } from '../../services/market.service.js'
import { toBrokerSymbol, normSymbol } from '../../services/brokerSymbol.service.js'
import { computeBasisOffset }         from '../broker/brokerPrice.service.js'
import { resolveConditionTree, extractLeaves, topOperator, firstLeafTimeframe } from '../../services/conditionTree.service.js'
import { cleanConviction } from '../../services/conviction.util.js'
import { placeOrdersForIdea, placeRestingEntryForIdea, triggerEntryNow } from './ideaExecution.service.js'
import { armExitsInPosition } from './exitOrders.service.js'

const LOG = '[idea]'
const COLLECTION = 'ideas'

const LOCKED_DELETE_STATUSES = new Set(['long', 'short'])
const VALID_STATUSES = new Set(['waiting', 'looking', 'resting', 'hit', 'long', 'short', 'closed'])

// A pending idea can be flipped to an immediate market entry ("go in now") from the
// edit/build flow. Guard it tightly: only an explicit immediate flag on a still-pending
// (waiting/looking) idea — never an in-position, resting, hit, or closed one, and never a
// plain update that happened to carry the flag along (those strip it client-side).
export function shouldMarketEnterOnUpdate(patch, existingStatus) {
    return patch?.immediate === true && (existingStatus === 'waiting' || existingStatus === 'looking')
}

export const ideaService = {
    saveIdea,
    saveBatchIdeas,
    getIdeas,
    getAssetClassMap,
    getCallPositionMap,
    getIdeaById,
    deleteIdea,
    updateIdea,
    placeOrdersForIdea,
    triggerEntryNow,
}

export async function ensureIdeaIndexes() {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true })
        await db.collection(COLLECTION).createIndex({ userId: 1 })
        await db.collection(COLLECTION).createIndex({ status: 1 })
    } catch (err) {
        logger.warn(LOG, 'ensureIdeaIndexes failed:', err.message)
    }
}

const MAX_PERSISTED_MESSAGES = 40
function _trimChatState(chatState) {
    if (!chatState || typeof chatState !== 'object') return chatState ?? null
    const msgs = chatState.messages
    if (!Array.isArray(msgs) || msgs.length <= MAX_PERSISTED_MESSAGES) return chatState
    return { ...chatState, messages: msgs.slice(-MAX_PERSISTED_MESSAGES) }
}

// True when an entry tree carries any gating leaf (price, indicator, TIME, news, …).
// resolveConditionTree returns null when there are truly no entry conditions, so a
// non-null tree always yields ≥1 leaf — but count leaves directly to stay correct
// under any future nesting change.
export function hasEntryConditions(tree) {
    return extractLeaves(tree).length > 0
}

// `immediate` means "fire a market order now, no entry conditions". A gating entry
// condition (a price level, an indicator, or a scheduled TIME leaf) makes the idea
// conditional by definition, so immediate only truly applies when the entry tree is
// empty. Backstops an agent that mislabels a scheduled/gated entry as immediate — which
// would otherwise bypass the monitor and enter at save time. See project_timestamp_ideas.
export function resolveImmediate(immediateFlag, entryTree) {
    return immediateFlag === true && !hasEntryConditions(entryTree)
}

// A 'closed' idea is terminal — a later status patch must never resurrect it. Guards against a
// stale write reverting a closed idea (e.g. Dismiss on an entry-confirm card that lingered in
// social chat and was clicked after the idea had already entered and closed, which would leave a
// mangled waiting-but-closed doc). See project_timestamp_ideas (Issue 2).
export function isClosedIdeaFrozen(existingStatus, patchStatus) {
    return existingStatus === 'closed' && patchStatus != null && patchStatus !== 'closed'
}

async function saveIdea(tradeIdea, userId) {
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

    // Explicit "go in now" (shouldMarketEnterOnUpdate) is a separate, deliberate user
    // gesture and is not affected by this — only the agent-emitted save path is guarded.
    const isImmediate = resolveImmediate(tradeIdea.immediate, entryTree)
    if (tradeIdea.immediate === true && !isImmediate) {
        logger.warn(LOG, 'immediate:true ignored — idea has gating entry conditions; saving as monitored', { asset: tradeIdea.asset ?? tradeIdea.ticker })
    }

    const enriched = {
        id:              randomUUID(),
        savedAt:         Date.now(),
        status:          isImmediate ? 'hit' : 'waiting',
        entryTriggeredAt: isImmediate ? Date.now() : undefined,
        immediate:       isImmediate || undefined,
        asset:           tradeIdea.asset           ?? tradeIdea.ticker ?? '',
        asset_class:     tradeIdea.asset_class     ?? null,
        direction:       tradeIdea.direction       ?? null,
        type:            tradeIdea.type            ?? null,
        quantity:        tradeIdea.quantity        != null ? Number(tradeIdea.quantity) : null,

        entryOrderType:    tradeIdea.entry_order_type === 'stop' ? 'stop' : null,
        entryTriggerPrice: null,

        entry_timeframe: tradeIdea.entry_timeframe ?? null,
        stop_timeframe:  tradeIdea.stop_timeframe  ?? null,
        tp_timeframe:    tradeIdea.tp_timeframe    ?? null,

        entry_condition_tree: entryTree  ?? null,
        stop_condition_tree:  stopTree   ?? null,
        tp_condition_tree:    tpTree     ?? null,

        entry_conditions: extractLeaves(entryTree),
        entry_logic:      topOperator(entryTree) ?? 'AND',
        stop_conditions:  extractLeaves(stopTree),
        stop_logic:       topOperator(stopTree)  ?? 'OR',
        tp_conditions:    extractLeaves(tpTree),
        tp_logic:         topOperator(tpTree)    ?? 'OR',

        additional_entries: additionalEntries,
        notes:      tradeIdea.notes      ?? null,

        invalidation:        _normalizeInvalidation(tradeIdea.invalidation),
        invalidation_status: null,
        invalidation_reason: null,
        invalidation_edge:   null,
        invalidation_armed:  false,   // waiting→armed latch (see invalidation.monitor.js)

        chat_state: _trimChatState(tradeIdea.chat_state),
        accounts:      Array.isArray(tradeIdea.accounts) ? tradeIdea.accounts : [],
        mainAccountId: tradeIdea.mainAccountId ?? null,
        userId:        userId               ?? null,
        portfolioId:     tradeIdea.portfolioId     ?? undefined,
        portfolioName:   tradeIdea.portfolioName   ?? undefined,
        allocationRatio: tradeIdea.allocationRatio ?? undefined,
        callId:          tradeIdea.callId           ?? undefined,   // set ⟺ spawned from a Kairos call; flows to the trade's origin block
        conviction:      cleanConviction(tradeIdea.conviction),
    }

    try {
        if (enriched.entryOrderType === 'stop') {
            const level = await detectNativeEntryLevel(enriched)
            if (level != null) {
                enriched.entryTriggerPrice = level
            } else {
                logger.warn(LOG, 'entry_order_type=stop but entry is not a bare price level — falling back to monitored', { asset: enriched.asset })
                enriched.entryOrderType = null
            }
        }

        const partitions = await _partitionByBroker(enriched, userId)

        // Gate #5: every monitored idea needs a trading venue (a real broker or paper).
        // A null-broker partition = no account resolved and paper off → reject rather than
        // persist a dead idea the monitor can never act on. The PRIMARY gate is agent-level
        // (it won't reach setup without a marked venue); this is the defensive backstop.
        if (partitions.every(p => p.broker == null)) {
            logger.warn(LOG, 'Idea has no trading venue — not saved', { asset: enriched.asset })
            return { ok: false, reason: 'no_venue', error: new Error('No trading venue — connect a broker or enable paper') }
        }

        const forked  = partitions.length > 1
        const groupId = forked ? `grp_${enriched.id}` : null

        const children = []
        for (let i = 0; i < partitions.length; i++) {
            const part         = partitions[i]
            const accountId    = part.mainAccountId ?? part.accountIds[0] ?? null
            const brokerSymbol = await _resolveBrokerSymbol(part.broker, userId, accountId, enriched.asset)
            const child = {
                ...enriched,
                id:            forked ? `${enriched.id}-${i + 1}` : enriched.id,
                accounts:      part.accountIds,
                mainAccountId: part.mainAccountId,
                groupId,
                broker:        part.broker,
                brokerSymbol,
                // Basis offset measured ONCE, here. Downstream (monitor candle-shift, order
                // placement) apply this stored scalar; 0 for everything but aliased index
                // futures, so the shift is a no-op elsewhere. See brokerPrice.service.
                basisOffset:   await _basisOffset(brokerSymbol, enriched.asset),
            }

            if (isImmediate) await _attachImmediatePlan(child)
            children.push(child)
        }

        const db = await getDb()
        await db.collection(COLLECTION).insertMany(children)
        logger.info(LOG, 'Idea saved', { id: enriched.id, asset: enriched.asset, immediate: isImmediate, forked, children: children.length })

        return { ok: true, idea: stripId(children[0]), ideas: children.map(stripId) }
    } catch (err) {
        logger.error(LOG, 'Failed to save idea', err)
        return { ok: false, error: err }
    }
}

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
        return { ok: true, idea: stripId(idea) }
    } catch (err) {
        logger.error(LOG, 'Failed to get idea by id', err)
        return { ok: false, error: err }
    }
}

async function getIdeas(userId, isAdmin = false) {
    try {
        const db = await getDb()
        const query = isAdmin ? {} : { userId }
        // Exclude Kairos-owned ideas: a confirmed call materializes an idea stamped ownedBy:'hermes'
        // as its execution vehicle. It's surfaced as the Call row (Calls tab) + its live position, so
        // it must NOT also appear as a standalone idea. ($ne also matches ideas with no ownedBy.)
        query.ownedBy = { $ne: 'hermes' }
        const items = await db.collection(COLLECTION).find(query).sort({ savedAt: -1 }).toArray()
        return items.map(stripId)
    } catch (err) {
        logger.error(LOG, 'Failed to get ideas', err)
        return []
    }
}

async function getAssetClassMap(userId) {
    try {
        const db = await getDb()
        const rows = await db.collection(COLLECTION)
            .find({ userId, asset_class: { $ne: null } }, { projection: { asset: 1, asset_class: 1 } })
            .toArray()
        const map = {}
        for (const r of rows) if (r.asset) map[normSymbol(r.asset)] = r.asset_class
        return map
    } catch (err) {
        logger.warn(LOG, 'getAssetClassMap failed', err.message)
        return {}
    }
}

/**
 * Map of `broker:accountId:positionId` → callId for call-originated open positions. A confirmed
 * Kairos call materializes an execution idea stamped ownedBy:'hermes' (hidden from the ideas list,
 * see getIdeas) carrying its origin callId; that idea's brokerOrders link the live broker position.
 * The Positions tab resolves a row's owner through the visible ideas list, so a call's position has
 * no resolvable owner and clicking it is a dead no-op. This lets the /positions route stamp the
 * owning callId onto the position → the client opens the Call pop-out instead. Keyed to match the
 * broker/account/positionId the client already carries on each position.
 */
async function getCallPositionMap(userId) {
    try {
        const db = await getDb()
        const rows = await db.collection(COLLECTION)
            .find({ userId, ownedBy: 'hermes', callId: { $ne: null } },
                  { projection: { callId: 1, brokerOrders: 1 } })
            .toArray()
        const map = {}
        for (const r of rows) {
            for (const bo of r.brokerOrders ?? []) {
                if (bo?.positionId == null) continue
                map[`${bo.broker}:${bo.accountId}:${bo.positionId}`] = r.callId
            }
        }
        return map
    } catch (err) {
        logger.warn(LOG, 'getCallPositionMap failed', err.message)
        return {}
    }
}

async function deleteIdea(id, userId, isAdmin = false) {
    try {
        const db = await getDb()
        const idea = await db.collection(COLLECTION).findOne({ id })
        if (!idea) return { ok: false, reason: 'not_found' }
        if (idea.userId && idea.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }
        if (LOCKED_DELETE_STATUSES.has(idea.status)) return { ok: false, reason: 'in_position' }

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

    if (patch.status === 'resting') {
        return placeRestingEntryForIdea(id, userId, isAdmin)
    }

    if (patch.invalidation !== undefined) {
        patch.invalidation = _normalizeInvalidation(patch.invalidation)
        // Editing the range re-arms the watcher from scratch (back to waiting).
        if (patch.invalidation_status === undefined) patch.invalidation_status = null
        if (patch.invalidation_reason === undefined) patch.invalidation_reason = null
        if (patch.invalidation_edge   === undefined) patch.invalidation_edge   = null
        if (patch.invalidation_armed  === undefined) patch.invalidation_armed  = false
    }

    if (patch.entry_conditions !== undefined || patch.stop_conditions !== undefined || patch.tp_conditions !== undefined) {
        const entryTree = resolveConditionTree(patch.entry_condition_tree, patch.entry_conditions, patch.entry_logic ?? 'AND')
        const stopTree  = resolveConditionTree(patch.stop_condition_tree,  patch.stop_conditions,  patch.stop_logic  ?? 'OR')
        const tpTree    = resolveConditionTree(patch.tp_condition_tree,    patch.tp_conditions,    patch.tp_logic    ?? 'OR')
        if (entryTree) { patch.entry_condition_tree = entryTree; patch.entry_conditions = extractLeaves(entryTree) }
        if (stopTree)  { patch.stop_condition_tree  = stopTree;  patch.stop_conditions  = extractLeaves(stopTree)  }
        if (tpTree)    { patch.tp_condition_tree    = tpTree;    patch.tp_conditions    = extractLeaves(tpTree)    }
    }

    if (patch.status === 'closed') patch.chat_state = null
    else if (patch.chat_state) patch.chat_state = _trimChatState(patch.chat_state)

    if (patch.status === 'looking') {
        patch.monitorPhase     = 'entry'
        patch.entryTriggeredAt = null
        patch.activatedAt      = Date.now()
        minosService.resetIdea(id)
    }

    if (patch.status === 'hit') {
        patch.entryTriggeredAt = Date.now()
    }

    try {
        const db = await getDb()

        const existing = await db.collection(COLLECTION).findOne(
            { id },
            { projection: { userId: 1, status: 1, brokerOrders: 1, stop_condition_tree: 1, tp_condition_tree: 1 } },
        )
        if (!existing) return { ok: false, reason: 'not_found' }
        if (existing.userId && existing.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }

        if (isClosedIdeaFrozen(existing.status, patch.status)) {
            logger.info(LOG, `[${id}] Ignoring status→${patch.status} on a closed idea (terminal)`)
            return { ok: false, reason: 'already_closed', idea: null }
        }

        const inPosition = existing.status === 'long' || existing.status === 'short'
        if (inPosition && patch.status !== 'closed') {
            if (patch.status != null && patch.status !== existing.status) {
                patch.status = existing.status
                delete patch.entryTriggeredAt
                delete patch.monitorPhase
                delete patch.activatedAt
            }
            const editsExits = patch.stop_conditions !== undefined || patch.tp_conditions !== undefined
            if (editsExits) {
                const full   = await db.collection(COLLECTION).findOne({ id })
                const merged = { ...full, ...patch }

                const broker = (full.brokerOrders ?? []).find(b => b.positionId != null)?.broker
                if (broker) { merged.brokerSymbol = toBrokerSymbol(broker, merged.asset); patch.brokerSymbol = merged.brokerSymbol }

                const route = await routeExits(merged)
                const { exitOrders, referenceQuote } = await armExitsInPosition(merged, route)

                patch.exitOrders = exitOrders
                patch.nativeExit = {
                    stop: route.stop.nativeOrders,
                    tp:   route.tp.nativeOrders,
                    referenceQuote: referenceQuote ?? null,
                }
                patch.monitorStop     = route.stop.monitorTree != null
                patch.monitorTp       = route.tp.monitorTree   != null
                patch.stopMonitorTree = route.stop.monitorTree
                patch.tpMonitorTree   = route.tp.monitorTree
                patch.firedExits      = []
                minosService.resetIdea(id)
            }
        }

        if (existing.status === 'resting' && patch.status === 'waiting') {
            await _cancelRestingOrders({ id, status: 'resting', brokerOrders: existing.brokerOrders }, existing.userId ?? userId)
            patch.orderState      = null
            patch.brokerOrders    = null
            patch.restingPlacedAt = null
            minosService.resetIdea(id)
        }

        if (existing.status === 'hit' && patch.status === 'waiting') {
            patch.entryTriggeredAt = null
            patch.pendingOrder     = null
            patch.orderState       = null
            if (patch.resetWindow === true) {
                patch.entryFloorAt          = Date.now()
                patch.triggeredWhileWaiting = false
                patch.triggerEventAt        = null
            }
            minosService.resetIdea(id)
        }

        // "Reset" from the arm-time pre-flight prompt: keep the idea 'looking' but
        // push the entry floor forward to now, so a level that's already held is
        // ignored and only a fresh cross from here on fires.
        if (patch.resetPreEntry) {
            patch.entryFloorAt = Date.now()
            minosService.resetIdea(id)
        }
        delete patch.resetPreEntry

        delete patch.resetWindow

        // "Go in at market now" from the edit/build flow: flip a still-pending idea
        // to immediate. Mirrors saveIdea's immediate path — transition to 'hit' and
        // attach the order plan so the OrderConfirm dialog surfaces. In-position,
        // resting, hit and closed ideas are left untouched (can't market-enter them).
        if (shouldMarketEnterOnUpdate(patch, existing.status)) {
            patch.status           = 'hit'
            patch.entryTriggeredAt = Date.now()
            const merged = { ...(await db.collection(COLLECTION).findOne({ id })), ...patch }
            const plan   = await buildOrderPlanForIdea(merged)
            if (plan.length > 0) {
                const open = isAssetOpen(merged.asset, merged.asset_class)
                patch.pendingOrder = { plan, builtAt: Date.now() }
                patch.orderState   = open ? 'awaiting_confirm' : 'awaiting_market'
            }
            minosService.resetIdea(id)
        }

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

        // Arm-time pre-flight: if the entry level is already satisfied on the last
        // closed candle (so the monitor's rising-edge will never fire), tell the
        // client to prompt the user (Buy now / Edit / Reset). Best-effort — never
        // blocks or fails the update.
        let preEntry
        if (patch.status === 'looking') {
            preEntry = await minosService.preflightEntry(result)
        }

        return { ok: true, idea: stripId(result), ...(preEntry && { preEntry }) }
    } catch (err) {
        logger.error(LOG, 'Failed to update idea', err)
        return { ok: false, error: err }
    }
}

async function saveBatchIdeas(plan, userId, accounts = [], mainAccountId = null, portfolioId = null) {
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
 * Resolve the broker's tradable symbol for an idea ("getTicker") — ask the broker's live
 * symbol list so the persisted brokerSymbol is the broker's real name (e.g. 'US100.cash').
 * Falls back to the static alias map when the broker can't resolve (unsupported), can't be
 * reached (transport error), or genuinely doesn't list the instrument. Never throws — a
 * failure just yields the static-map guess, so save never breaks on a symbol lookup.
 * @returns {Promise<string|null>}
 */
async function _resolveBrokerSymbol(broker, userId, accountId, asset) {
    if (!broker) return null
    // Static map first: bridge the semantic gap the broker CAN'T (NQ→US100) — the broker's
    // symbol list only knows its own names. Then ask the broker to resolve that base to its
    // exact tradable name (US100→US100.cash) and confirm it's listed.
    const mapped = toBrokerSymbol(broker, asset)
    try {
        const res = await brokerService.resolveSymbol(broker, userId, accountId, mapped)
        if (res?.found && res.symbol) return res.symbol
    } catch (err) {
        logger.warn(LOG, `getTicker ${asset}→${mapped} on ${broker} failed — using static map: ${err.message}`)
    }
    return mapped
}

/**
 * Measure the basis offset for an idea ONCE, at fork time (see brokerPrice.service).
 * A non-zero scalar only for aliased index futures; 0 for everything else. Persisted on
 * the idea so the monitor (candle-shift) and execution (order-price shift) apply it
 * without re-measuring. Never throws — a failure yields 0 (no shift, place at authored).
 * @returns {Promise<number>}
 */
async function _basisOffset(brokerSymbol, asset) {
    try {
        const { offset } = await computeBasisOffset({ brokerSymbol, asset })
        return offset || 0
    } catch (err) {
        logger.warn(LOG, `basis offset failed for ${asset}→${brokerSymbol}: ${err.message}`)
        return 0
    }
}

async function _partitionByBroker(idea, userId) {
    const accountIds = (idea.accounts ?? []).map(a => String(typeof a === 'object' ? a.id : a))
    const globalMain = idea.mainAccountId != null ? String(idea.mainAccountId) : null

    // Account binding is per-idea and explicit: the account(s) the user picked (paper or
    // real broker) route the idea via resolveUserAccounts below. There is NO silent global
    // default — the paper toggle is a workspace VIEW switch only, never a router. An idea
    // with no account bound resolves to a null-broker (no venue); the idea agent prompts
    // the user to pick an account before it gets that far.
    if (accountIds.length === 0) return [{ broker: null, accountIds: [], mainAccountId: globalMain }]

    const brokerById = new Map()
    try {
        const resolved = await resolveUserAccounts(userId, accountIds)
        for (const [id, acct] of resolved) brokerById.set(id, acct.broker)
    } catch (err) {
        logger.warn(LOG, `fork: account→broker resolve failed, not forking: ${err.message}`)
        return [{ broker: null, accountIds, mainAccountId: globalMain }]
    }

    const { partitions, unresolved } = _groupByBroker(accountIds, brokerById, globalMain)
    if (unresolved.length) logger.warn(LOG, 'fork: dropping accounts with no resolved broker', { ids: unresolved })
    return partitions
}

export function _groupByBroker(accountIds, brokerById, globalMain) {
    const byBroker = new Map()
    for (const id of accountIds) {
        const broker = brokerById.get(id) ?? null
        if (!byBroker.has(broker)) byBroker.set(broker, [])
        byBroker.get(broker).push(id)
    }

    const known = [...byBroker.keys()].filter(b => b != null)
    if (known.length <= 1) {
        return {
            partitions: [{ broker: known[0] ?? null, accountIds, mainAccountId: globalMain }],
            unresolved: [],
        }
    }

    const partitions = known.map(broker => {
        const ids = byBroker.get(broker)
        return { broker, accountIds: ids, mainAccountId: ids.includes(globalMain) ? globalMain : null }
    })
    return { partitions, unresolved: byBroker.get(null) ?? [] }
}

// Invalidation = the actionable entry price RANGE (what breaks the setup). The
// idea is invalidated when price closes outside [lower, upper] on either edge.
// `conditions` is reserved for the full condition-type taxonomy (news/earnings/
// chart/indicator) used by portfolio long-horizon mode — stored, not monitored in v1.
function _normalizeInvalidation(raw) {
    if (!raw || typeof raw !== 'object') return null

    const r   = raw.range && typeof raw.range === 'object' ? raw.range : raw
    const num = v => (v != null && Number.isFinite(Number(v))) ? Number(v) : null
    const str = v => (typeof v === 'string' && v.trim()) ? v.trim() : null

    const lower = num(r.lower)
    const upper = num(r.upper)
    const range = (lower != null || upper != null) ? {
        lower,
        upper,
        lowerAnchor: str(r.lowerAnchor),
        upperAnchor: str(r.upperAnchor),
        // Away pivot for a distant entry: the structural level, on the side price
        // must travel FROM, past which the setup is drifting away (see the approach
        // guard in invalidation.monitor.js). Optional — only when entry is far from spot.
        approach:       num(r.approach),
        approachAnchor: str(r.approachAnchor),
    } : null

    const conditions = Array.isArray(raw.conditions) ? raw.conditions : []

    if (!range && conditions.length === 0) return null
    return { range, conditions }
}
