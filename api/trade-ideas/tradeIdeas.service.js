import { randomUUID }       from 'crypto'
import { getDb, stripId }  from '../../providers/mongodb.provider.js'
import { logger }          from '../../services/logger.service.js'
import { monitorService }  from '../../monitoring/monitor.service.js'
import { brokerService }   from '../broker/broker.service.js'
import { buildOrderPlanForIdea, resolveUserAccounts } from '../../services/orderPlan.service.js'
import { routeExits, currentReferencePrice, detectNativeEntryLevel } from '../../services/protectionPlan.service.js'
import { isAssetOpen } from '../../services/market.service.js'
import { toBrokerSymbol, normSymbol } from '../../services/brokerSymbol.service.js'
import { resolveConditionTree, extractLeaves, topOperator, firstLeafTimeframe } from '../../services/conditionTree.service.js'
import { cleanConviction } from '../../services/conviction.util.js'
import { placeOrdersForIdea, placeRestingEntryForIdea } from './ideaExecution.service.js'
import { armExitsInPosition } from './exitOrders.service.js'
import { paperBrokerService } from '../broker/paperBroker.service.js'

const LOG = '[idea]'
const COLLECTION = 'ideas'

const LOCKED_DELETE_STATUSES = new Set(['long', 'short'])
const VALID_STATUSES = new Set(['waiting', 'looking', 'resting', 'hit', 'long', 'short', 'closed'])

export const ideaService = {
    saveIdea,
    saveBatchIdeas,
    getIdeas,
    getAssetClassMap,
    getIdeaById,
    deleteIdea,
    updateIdea,
    placeOrdersForIdea,
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

    const isImmediate = tradeIdea.immediate === true

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

        chat_state: _trimChatState(tradeIdea.chat_state),
        accounts:      Array.isArray(tradeIdea.accounts) ? tradeIdea.accounts : [],
        mainAccountId: tradeIdea.mainAccountId ?? null,
        userId:        userId               ?? null,
        portfolioId:     tradeIdea.portfolioId     ?? undefined,
        portfolioName:   tradeIdea.portfolioName   ?? undefined,
        allocationRatio: tradeIdea.allocationRatio ?? undefined,
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
                broker:        part.broker ?? null,
                brokerSymbol:  part.broker ? toBrokerSymbol(part.broker, enriched.asset) : null,
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
        if (patch.invalidation_status === undefined) patch.invalidation_status = null
        if (patch.invalidation_reason === undefined) patch.invalidation_reason = null
        if (patch.invalidation_edge   === undefined) patch.invalidation_edge   = null
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
        monitorService.resetIdea(id)
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
                monitorService.resetIdea(id)
            }
        }

        if (existing.status === 'resting' && patch.status === 'waiting') {
            await _cancelRestingOrders({ id, status: 'resting', brokerOrders: existing.brokerOrders }, existing.userId ?? userId)
            patch.orderState      = null
            patch.brokerOrders    = null
            patch.restingPlacedAt = null
            monitorService.resetIdea(id)
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
            monitorService.resetIdea(id)
        }

        delete patch.resetWindow

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
        return { ok: true, idea: stripId(result) }
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

async function _partitionByBroker(idea, userId) {
    // Global paper mode: route EVERY new idea to the simulated broker on the user's
    // single paper account, regardless of which live accounts were selected.
    const paper = await paperBrokerService.getAccount(userId)
    if (paper?.enabled) {
        return [{ broker: 'paper', accountIds: [paper.accountId], mainAccountId: paper.accountId }]
    }

    const accountIds = (idea.accounts ?? []).map(a => String(typeof a === 'object' ? a.id : a))
    const globalMain = idea.mainAccountId != null ? String(idea.mainAccountId) : null
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
    } : null

    const conditions = Array.isArray(raw.conditions) ? raw.conditions : []

    if (!range && conditions.length === 0) return null
    return { range, conditions }
}
