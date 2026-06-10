import { getDb }           from '../../providers/mongodb.provider.js'
import { logger }          from '../../services/logger.service.js'
import { monitorService }  from '../../monitoring/monitor.service.js'

const LOG = '[idea]'
const COLLECTION = 'ideas'

const VALID_STATUSES = new Set(['waiting', 'looking', 'hit', 'long', 'short', 'closed'])

export const ideaService = {
    saveIdea,
    getIdeas,
    getIdeaById,
    deleteIdea,
    updateIdea,
}

async function saveIdea(tradeIdea, userId) {
    // Resolve condition trees from either new tree format or legacy flat arrays
    const entryTree = _resolveConditionTree(tradeIdea.entry_condition,  tradeIdea.entry_conditions, tradeIdea.entry_logic ?? 'AND')
    const stopTree  = _resolveConditionTree(tradeIdea.stop_loss,        tradeIdea.stop_conditions,  tradeIdea.stop_logic  ?? 'OR')
    const tpTree    = _resolveConditionTree(tradeIdea.take_profit,      tradeIdea.tp_conditions,    tradeIdea.tp_logic    ?? 'OR')

    const additionalEntries = (tradeIdea.additional_entries ?? []).map(ae => {
        const tree = _resolveConditionTree(ae.condition_tree, ae.conditions, ae.logic ?? 'AND')
        return {
            condition_tree: tree ?? null,
            conditions:     _extractLeaves(tree),
            logic:          ae.logic ?? 'AND',
            quantity:       ae.quantity != null ? Number(ae.quantity) : null,
            triggeredAt:    null,
            filledAt:       null,
        }
    })

    const enriched = {
        id:              String(Date.now()),
        savedAt:         Date.now(),
        status:          'waiting',
        asset:           tradeIdea.asset           ?? tradeIdea.ticker ?? '',
        direction:       tradeIdea.direction       ?? null,
        type:            tradeIdea.type            ?? null,
        quantity:        tradeIdea.quantity        != null ? Number(tradeIdea.quantity) : null,
        entry_timeframe: tradeIdea.entry_timeframe ?? null,
        stop_timeframe:  tradeIdea.stop_timeframe  ?? null,
        tp_timeframe:    tradeIdea.tp_timeframe    ?? null,

        // Tree format — primary source for the monitor
        entry_condition_tree: entryTree  ?? null,
        stop_condition_tree:  stopTree   ?? null,
        tp_condition_tree:    tpTree     ?? null,

        // Flat format — backward compat and display
        entry_conditions: _extractLeaves(entryTree),
        entry_logic:      _topOperator(entryTree) ?? 'AND',
        stop_conditions:  _extractLeaves(stopTree),
        stop_logic:       _topOperator(stopTree)  ?? 'OR',
        tp_conditions:    _extractLeaves(tpTree),
        tp_logic:         _topOperator(tpTree)    ?? 'OR',

        additional_entries: additionalEntries,
        notes:      tradeIdea.notes      ?? null,
        chat_state: tradeIdea.chat_state ?? null,
        accounts:   Array.isArray(tradeIdea.accounts) ? tradeIdea.accounts : [],
        userId:     userId               ?? null,
    }

    try {
        const db = await getDb()
        await db.collection(COLLECTION).insertOne(enriched)
        logger.info(LOG, 'Idea saved', { id: enriched.id, asset: enriched.asset })
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

    // Rebuild condition trees when conditions are updated via chat edit
    if (patch.entry_conditions !== undefined || patch.stop_conditions !== undefined || patch.tp_conditions !== undefined) {
        const entryTree = _resolveConditionTree(patch.entry_condition_tree, patch.entry_conditions, patch.entry_logic ?? 'AND')
        const stopTree  = _resolveConditionTree(patch.stop_condition_tree,  patch.stop_conditions,  patch.stop_logic  ?? 'OR')
        const tpTree    = _resolveConditionTree(patch.tp_condition_tree,    patch.tp_conditions,    patch.tp_logic    ?? 'OR')
        if (entryTree) { patch.entry_condition_tree = entryTree; patch.entry_conditions = _extractLeaves(entryTree) }
        if (stopTree)  { patch.stop_condition_tree  = stopTree;  patch.stop_conditions  = _extractLeaves(stopTree)  }
        if (tpTree)    { patch.tp_condition_tree    = tpTree;    patch.tp_conditions    = _extractLeaves(tpTree)    }
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

    try {
        const db = await getDb()

        // Ownership check: read only the userId field (cheap projection)
        const existing = await db.collection(COLLECTION).findOne({ id }, { projection: { userId: 1 } })
        if (!existing) return { ok: false, reason: 'not_found' }
        if (existing.userId && existing.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }

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

// ─── Condition tree helpers ───────────────────────────────────────────────────

/**
 * Normalise a condition input into a canonical group tree node.
 * Handles:
 *   - New tree format:  { operator, children }  (pass through)
 *   - Wrapped leaf:     { condition, type, timeframe }  (wrap in group)
 *   - Old format:       { logic, conditions }   (rename fields)
 *   - Legacy flat arr:  array of leaf objects   (wrap in group)
 */
function _resolveConditionTree(treeNode, flatArray, defaultOperator = 'AND') {
    // New tree group node: { operator, children }
    if (treeNode && typeof treeNode === 'object' && !Array.isArray(treeNode)) {
        if (treeNode.operator && Array.isArray(treeNode.children) && treeNode.children.length > 0) {
            return treeNode
        }
        // Bare leaf node — wrap in a single-child group
        if (typeof treeNode.condition === 'string') {
            return { operator: defaultOperator, children: [treeNode] }
        }
        // Old format: { logic, conditions }
        if (Array.isArray(treeNode.conditions) && treeNode.conditions.length > 0) {
            return { operator: treeNode.logic ?? defaultOperator, children: treeNode.conditions }
        }
    }
    // Legacy flat array
    if (Array.isArray(flatArray) && flatArray.length > 0) {
        return { operator: defaultOperator, children: flatArray }
    }
    return null
}

/** Recursively extract all leaf condition objects from a tree. */
function _extractLeaves(node) {
    if (!node) return []
    if (typeof node.condition === 'string') return [node]
    if (Array.isArray(node.children)) return node.children.flatMap(_extractLeaves)
    return []
}

/** Return the top-level operator of a group node, or null. */
function _topOperator(node) {
    return node?.operator ?? null
}

// ─── Mongo helper ─────────────────────────────────────────────────────────────

// strip MongoDB's internal _id before sending to client
function _strip(doc) {
    if (!doc) return doc
    const { _id, ...rest } = doc
    return rest
}
