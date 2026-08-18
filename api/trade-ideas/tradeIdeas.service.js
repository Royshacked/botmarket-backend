import { randomUUID }       from 'crypto'
import { LIVE_POSITION, STATUS, statusesFor, isRestingEntry } from '../../services/entity/vocabulary.js'
import { getDb, stripId }  from '../../providers/mongodb.provider.js'
import { logger }          from '../../services/logger.service.js'
import { preflightEntry }   from '../../monitoring/preflightEntry.js'
import { clearsEntrySchedule, ENTRY_SCHEDULE_FIELD } from '../../monitoring/entry.monitor.js'
import { brokerService }   from '../broker/broker.service.js'
import { buildOrderPlanForIdea, resolveUserAccounts } from '../../services/orderPlan.service.js'
import { routeExits, detectNativeEntryLevel, touchLeaf } from '../../services/protectionPlan.service.js'
import { isAssetOpen } from '../../services/market.service.js'
import { toBrokerSymbol, normSymbol } from '../../services/brokerSymbol.service.js'
import { computeBasisOffset }         from '../broker/brokerPrice.service.js'
import { resolveMode }                from '../../services/venue.resolve.service.js'
import { resolveConditionTree, extractLeaves, topOperator } from '../../services/conditionTree.service.js'
import { cleanConviction } from '../../services/conviction.util.js'
import { placeOrdersForIdea, placeRestingEntryForIdea, triggerEntryNow } from './ideaExecution.service.js'
import { armExitsInPosition } from './exitOrders.service.js'
import { entityRepo }         from '../../services/entity/entityRepo.service.js'
import { makeEntityCrud, ownsEntity } from '../../services/entity/entityCrud.service.js'
import { kindForDoc }         from '../../services/entity/envelope.js'
import { ENTITIES }           from '../../services/entity/entityCollection.js'

const LOG = '[idea]'
const COLLECTION = ENTITIES

const VALID_STATUSES = new Set(statusesFor('idea'))

// Owner-scoped CRUD (the shared mechanism). The kind filter is a NEGATION, not a literal: this
// list is ideas AND portfolio legs (kind:'portfolio_item') but never calls — a call is surfaced on
// the Calls tab, never as a standalone idea.
//
// There is no `ownedBy:'hermes'` filter: that hid pre-P3b IDEA SHADOWS, the separate execution doc
// a confirmed call used to mint. Calls have self-executed since P3b (kairos.handoff merges the
// execution shape onto the call itself and sets no flag), and the legacy documents are gone. If a
// stray shadow ever turns up it now SHOWS in the list — which is the safer failure: an orphaned
// doc holding a broker position must be manageable, not invisible.
//
// Only a LIVE position is delete-locked; 'hit' stays deletable (confirm-gated).
const crud = makeEntityCrud({
    kind:       { $ne: 'call' },
    deleteLock: LIVE_POSITION,
    log:        LOG,
})

// A pending idea can be flipped to an immediate market entry ("go in now") from the
// edit/build flow. Guard it tightly: only an explicit immediate flag on a still-pending
// (waiting/looking) idea — never an in-position, resting, hit, or closed one, and never a
// plain update that happened to carry the flag along (those strip it client-side).
export function shouldMarketEnterOnUpdate(patch, existingStatus) {
    return patch?.immediate === true && (existingStatus === 'waiting' || existingStatus === 'looking')
}

export const ideaService = {
    saveIdea,
    buildIdeaChildren,
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

/**
 * The post-fill stamps for a leg born ALREADY AT A VENUE — the terminal state a book that wasn't
 * built here arrives in (docs/design/adopted-book.md), where the fill happened before the app ever
 * saw the name.
 *
 * The generate path writes a PROPOSAL: `waiting`, unactivated, gated by the pre-activation review
 * before anything becomes real. A born-live leg skips all of that, because there is nothing to
 * activate — offering it would invite the user to buy what they already own. One writer, one
 * parameter, two terminal states.
 *
 * Pure, and `at` is SUPPLIED rather than read from the clock: an adopted lot is routinely years old,
 * and holding period, the timeline and the ledger all measure from the real date.
 *
 * @param {{ direction:string|null,
 *           fill:{ broker:string, accountId:string, positionId:string, quantity:number, at:number } }} args
 */
export function bornLiveStamp({ direction, fill }) {
    const at = fill.at
    return {
        status:           direction === 'short' ? STATUS.SHORT : STATUS.LONG,
        entryTriggeredAt: at,
        // Also the double-place guard: `ordersPlacedAt` is what stops anything ever placing an entry
        // for this leg, which for a position that already exists is the whole point.
        ordersPlacedAt:   at,
        activatedAt:      at,
        orderState:       'placed',
        immediate:        undefined,
        brokerOrders: [{
            broker:     fill.broker,
            accountId:  String(fill.accountId),
            // No broker order ever existed, so the position IS the record. Both ids point at it, which
            // is what every downstream reader (exit routing, capture, the positions join) expects.
            orderId:    String(fill.positionId),
            positionId: String(fill.positionId),
            quantity:   Number(fill.quantity),
        }],
    }
}

// Legs that can be stated as a BARE PRICE, with the numeric field a caller may send instead of
// a condition. Ordered entry → stop → tp only for readable logs; the mapping is what matters.
const PRICE_LEVEL_LEGS = [
    ['entry_price', 'entry_conditions'],
    ['stop_price',  'stop_conditions'],
    ['tp_price',    'tp_conditions'],
]

/**
 * Accept a bare NUMBER for any exit/entry leg and expand it into the `touch` leaf the rest of
 * the system already speaks. The order ticket states its levels as prices — that is the whole
 * gesture — and a client should not have to know the sentence the condition parser expects, nor
 * which leaf `type` makes a level rest at the broker rather than sit on the monitor.
 *
 * An explicit `*_conditions` always WINS: a caller that authored real conditions (the agents, the
 * chat build path) is saying something a price can't, so a stray price field must not overwrite it.
 * Returns a NEW object — the input is a request body and stays untouched.
 *
 * @param {object} input
 * @returns {object}
 */
export function applyPriceLevels(input = {}) {
    const out = { ...input }
    for (const [priceKey, condKey] of PRICE_LEVEL_LEGS) {
        if (out[priceKey] === undefined) continue
        const level = out[priceKey]
        delete out[priceKey]
        if (out[condKey] !== undefined) continue          // authored conditions win
        // null clears the leg (remove a stop); a number sets it. Anything else is ignored
        // rather than persisted as a leg nothing can evaluate.
        if (level === null)              out[condKey] = []
        else if (Number.isFinite(Number(level))) out[condKey] = [touchLeaf(Number(level))]
    }
    return out
}

/**
 * Enrich + broker-partition an idea input into its child doc(s) — WITHOUT inserting. This is the
 * idea-creation engine (condition trees, brokerSymbol resolution, basisOffset, immediate plan)
 * shared by saveIdea (which inserts) and the Kairos handoff (P3b: merges the single child's
 * execution fields onto the call entity instead of minting a shadow). Returns
 * { ok, children, forked } or { ok:false, reason?, error }.
 */
async function buildIdeaChildren(rawIdea, userId, { born = 'proposed' } = {}) {
    const tradeIdea = applyPriceLevels(rawIdea)
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
        // Entity discriminator (P2): a holding (carries portfolioId) is a portfolio_item, else an idea.
        kind:            kindForDoc(tradeIdea),
        parentId:        tradeIdea.portfolioId ?? null,
        savedAt:         Date.now(),
        status:          isImmediate ? 'hit' : 'waiting',
        entryTriggeredAt: isImmediate ? Date.now() : undefined,
        immediate:       isImmediate || undefined,
        asset:           tradeIdea.asset           ?? tradeIdea.ticker ?? '',
        asset_class:     tradeIdea.asset_class     ?? null,
        direction:       tradeIdea.direction       ?? null,
        type:            tradeIdea.type            ?? null,
        quantity:        tradeIdea.quantity        != null ? Number(tradeIdea.quantity) : null,

        // Which broker order type the entry rests as. 'stop' is the breakout entry (trigger
        // ABOVE for a long); 'limit' is the pullback entry (trigger BELOW). Both rest at the
        // broker rather than on the monitor, so both need a bare price level — resolved below.
        entryOrderType:    isRestingEntry(tradeIdea.entry_order_type) ? tradeIdea.entry_order_type : null,
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
        // Vestigial: the price-envelope watcher that read these was deleted 2026-08-18 (nothing
        // authored the band). Still written so existing documents keep one shape.
        invalidation_armed:  false,

        chat_state: _trimChatState(tradeIdea.chat_state),
        accounts:      Array.isArray(tradeIdea.accounts) ? tradeIdea.accounts : [],
        mainAccountId: tradeIdea.mainAccountId ?? null,
        userId:        userId               ?? null,
        portfolioId:     tradeIdea.portfolioId     ?? undefined,
        portfolioName:   tradeIdea.portfolioName   ?? undefined,
        allocationRatio: tradeIdea.allocationRatio ?? undefined,
        callId:          tradeIdea.callId           ?? undefined,   // set ⟺ spawned from a Kairos call; flows to the trade's origin block
        conviction:      cleanConviction(tradeIdea.conviction),
        // We RECORDED this position but never DECIDED it — the entry was made at a bank before we saw
        // the name. Orthogonal to `born` (a future broker-read import is born live and NOT adopted),
        // and it rides to the ledger's origin block so the track record can't claim the entry.
        adopted:         tradeIdea.adopted === true ? true : undefined,
        adoptedAt:       tradeIdea.adopted === true ? (tradeIdea.adoptedAt ?? Date.now()) : undefined,
    }

    try {
        if (enriched.entryOrderType) {
            const level = await detectNativeEntryLevel(enriched)
            if (level != null) {
                enriched.entryTriggerPrice = level
            } else {
                logger.warn(LOG, `entry_order_type=${enriched.entryOrderType} but entry is not a bare price level — falling back to monitored`, { asset: enriched.asset })
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

        // A born-live leg carries ONE position, on ONE account. Forking would stamp that single
        // positionId onto two documents, and both would then believe they own the same position —
        // so this refuses rather than half-recording a real holding.
        if (born === 'live') {
            if (!enriched.quantity) return { ok: false, reason: 'bad_quantity', error: new Error('born-live leg needs a quantity') }
            if (rawIdea.fill?.positionId == null) return { ok: false, reason: 'no_fill', error: new Error('born-live leg needs a fill') }
            if (forked) return { ok: false, reason: 'fill_spans_accounts', error: new Error('a born-live leg cannot fork across accounts') }
        }

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
                // The workspace, FROZEN at bind. This is the moment mode becomes knowable — the
                // venue is decided right here — and it never changes afterwards, so it is stamped
                // rather than re-derived. Per PARTITION, because a forked idea can straddle
                // workspaces (a paper leg and a live leg are different modes of the same idea).
                // Lets the frontend read `idea.mode` instead of re-implementing the rule.
                mode:          resolveMode({ broker: part.broker, accounts: part.accountIds, mainAccountId: part.mainAccountId }),
                brokerSymbol,
                // Basis offset measured ONCE, here. Downstream (monitor candle-shift, order
                // placement) apply this stored scalar; 0 for everything but aliased index
                // futures, so the shift is a no-op elsewhere. See brokerPrice.service.
                basisOffset:   await _basisOffset(brokerSymbol, enriched.asset),
            }

            // Born live → the post-fill stamps and NO order plan: the fill already happened, so
            // building one would be an order for a position we are holding.
            if (born === 'live') {
                Object.assign(child, bornLiveStamp({
                    direction: child.direction,
                    fill: {
                        ...rawIdea.fill,
                        broker:    rawIdea.fill.broker    ?? child.broker,
                        accountId: rawIdea.fill.accountId ?? accountId,
                        quantity:  rawIdea.fill.quantity  ?? child.quantity,
                        at:        rawIdea.fill.at        ?? Date.now(),
                    },
                }))
            } else if (isImmediate) {
                await _attachImmediatePlan(child)
            }
            children.push(child)
        }

        return { ok: true, children, forked }
    } catch (err) {
        logger.error(LOG, 'Failed to build idea children', err)
        return { ok: false, error: err }
    }
}

async function saveIdea(tradeIdea, userId, opts = {}) {
    const built = await buildIdeaChildren(tradeIdea, userId, opts)
    if (!built.ok) return built
    try {
        const { children } = built
        const db = await getDb()
        await db.collection(COLLECTION).insertMany(children)
        logger.info(LOG, 'Idea saved', { id: children[0].id, asset: children[0].asset, forked: built.forked, children: children.length })

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

// Crud shape `{ ok, doc }` straight through; the route's `{ idea: … }` envelope is applied at the
// HTTP tier, where the rest of this route's legacy body shapes already live.
async function getIdeaById(id, userId) {
    return crud.getOwnedStripped(id, userId)
}

async function getIdeas(userId) {
    return crud.list(userId)
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
 * Kairos call carries its own execution (kind:'call', self-origin callId) whose brokerOrders link
 * the live broker position (P3b). The Positions tab resolves a row's owner through the visible ideas
 * list, so a call's position has no resolvable owner and clicking it is a dead no-op. This lets the
 * /positions route stamp the owning callId onto the position → the client opens the Call pop-out.
 */
async function getCallPositionMap(userId) {
    try {
        const db = await getDb()
        const rows = await db.collection(COLLECTION)
            .find({ userId, callId: { $ne: null }, kind: 'call' },
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

async function deleteIdea(id, userId) {
    // Resting broker orders are cancelled only once the guards pass — remove() runs the hook
    // after not_found / forbidden / in_position have all been cleared.
    return crud.remove(id, userId, {
        onBeforeDelete: idea => _cancelRestingOrders(idea, idea.userId ?? userId),
    })
}

async function updateIdea(id, rawPatch, userId) {
    // Bare price levels expand to touch leaves BEFORE anything reads the legs — the in-position
    // exit-arming branch below keys off `patch.stop_conditions !== undefined`, so a ticket that
    // sent only `stop_price` would otherwise be seen as touching no exits at all.
    const patch = applyPriceLevels(rawPatch)

    if (patch.status !== undefined && !VALID_STATUSES.has(patch.status)) {
        return { ok: false, reason: 'invalid_status' }
    }

    if (patch.status === 'resting') {
        return placeRestingEntryForIdea(id, userId)
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
        if (!ownsEntity(existing, userId)) return { ok: false, reason: 'forbidden' }

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
            }
        }

        if (existing.status === 'resting' && patch.status === 'waiting') {
            await _cancelRestingOrders({ id, status: 'resting', brokerOrders: existing.brokerOrders }, existing.userId ?? userId)
            patch.orderState      = null
            patch.brokerOrders    = null
            patch.restingPlacedAt = null
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
        }

        // "Reset" from the arm-time pre-flight prompt: keep the idea 'looking' but
        // push the entry floor forward to now, so a level that's already held is
        // ignored and only a fresh cross from here on fires.
        if (patch.resetPreEntry) {
            patch.entryFloorAt = Date.now()
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
            const merged = { ...(await entityRepo.getById(id)), ...patch }
            const plan   = await buildOrderPlanForIdea(merged)
            if (plan.length > 0) {
                const open = isAssetOpen(merged.asset, merged.asset_class)
                patch.pendingOrder = { plan, builtAt: Date.now() }
                patch.orderState   = open ? 'awaiting_confirm' : 'awaiting_market'
            }
        }

        // ARM MEANS CHECK IT NOW — the entry monitor's cadence is persisted, so a stale wake-up
        // time would have it sleep straight through the arm. Both the rule and the field it clears
        // belong to that monitor (entry.monitor.clearsEntrySchedule), so this cannot drift if the
        // loop ever moves where it keeps its schedule. Setups do the same on re-arm.
        if (clearsEntrySchedule(patch)) patch[ENTRY_SCHEDULE_FIELD] = null

        // Ownership guard: you may only patch your own idea (legacy ownerless ideas pass an
        // empty guard). The write funnels through entityRepo (P1b).
        const ownerGuard = existing.userId ? { userId } : {}

        const result = await entityRepo.patchAndGet(id, patch, ownerGuard)
        if (!result) return { ok: false, reason: 'not_found' }
        logger.info(LOG, 'Idea updated', { id, patch })

        // Arm-time pre-flight: if the entry level is already satisfied on the last
        // closed candle (so the monitor's rising-edge will never fire), tell the
        // client to prompt the user (Buy now / Edit / Reset). Best-effort — never
        // blocks or fails the update.
        let preEntry
        if (patch.status === 'looking') {
            preEntry = await preflightEntry(result)
        }

        return { ok: true, idea: stripId(result), ...(preEntry && { preEntry }) }
    } catch (err) {
        logger.error(LOG, 'Failed to update idea', err)
        return { ok: false, error: err }
    }
}

/**
 * Write a whole book: one entity per leg, under one portfolioId. The ONE writer for a portfolio,
 * whoever assembled it.
 *
 * `born` is the terminal state, and it is the only thing that differs between a book Atlas
 * constructed and a book that already exists somewhere (docs/design/adopted-book.md):
 *   • `'proposed'` (default) — legs at `waiting`, gated by the pre-activation review. Today's path,
 *     byte-identical.
 *   • `'live'` — legs born in position, each leg carrying its own `fill` (see bornLiveStamp).
 *
 * PER-LEG OUTCOMES, not a blanket ok. A failed leg used to be a `logger.warn` inside a call that
 * returned `ok: true` regardless — fine for a proposal the user is about to review, and not fine for
 * a book of real positions, where a half-written result reported as success is how someone ends up
 * with holdings the app doesn't know it holds. So the mechanism REPORTS and the caller JUDGES:
 * construction stays lenient, adoption refuses on any `failed`.
 *
 * @param {{ name?:string, ideas:object[] }} plan
 * @param {{ accounts?:string[], mainAccountId?:string|null, portfolioId?:string|null,
 *           born?:'proposed'|'live' }} [opts]
 * @returns {Promise<{ ok:boolean, ideas:object[], failed:Array<{asset:string, reason:string}>, portfolioId:string }>}
 */
async function saveBatchIdeas(plan, userId, opts = {}) {
    const { accounts = [], mainAccountId = null, portfolioId = null, born = 'proposed' } = opts
    const pid    = portfolioId || `portfolio_${Date.now()}`
    const saved  = []
    const failed = []

    for (const idea of plan.ideas) {
        const result = await saveIdea({
            asset:           idea.asset,
            asset_class:     idea.asset_class,
            direction:       idea.direction,
            type:            idea.type,
            quantity:        idea.quantity,
            notes:           idea.notes,
            allocationRatio: idea.allocationRatio,
            portfolioId:     pid,
            portfolioName:   plan.name,
            accounts,
            mainAccountId,
            // Born-live extras — inert on the proposal path, where a plan leg carries neither.
            adopted:         idea.adopted,
            adoptedAt:       idea.adoptedAt,
            fill:            idea.fill,
        }, userId, { born })
        if (result.ok) saved.push(...(result.ideas ?? [result.idea]))
        else {
            const reason = result.reason ?? 'save_failed'
            failed.push({ asset: idea.asset, reason })
            logger.warn(LOG, 'Batch idea save failed', { asset: idea.asset, reason, error: result.error })
        }
    }

    logger.info(LOG, 'Batch saved', { portfolioId: pid, born, total: plan.ideas.length, saved: saved.length, failed: failed.length })
    return { ok: true, ideas: saved, failed, portfolioId: pid }
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
        // guard, deleted 2026-08-18). Optional — only when entry is far from spot.
        approach:       num(r.approach),
        approachAnchor: str(r.approachAnchor),
    } : null

    const conditions = Array.isArray(raw.conditions) ? raw.conditions : []

    if (!range && conditions.length === 0) return null
    return { range, conditions }
}
