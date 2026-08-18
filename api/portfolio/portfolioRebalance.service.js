/**
 * Portfolio rebalance execution.
 *
 * Applies an accepted `portfolio_update` (the agent's review proposal, confirmed by
 * the user) to the live book. This is the only path that turns a review into real
 * orders. Nothing here runs autonomously — the user confirms the whole block first.
 *
 * Action vocabulary (see portfolio_system_prompt.md "Portfolio Edit Output"). A holding is a
 * `portfolio_item` entity, so the actions are `_item` (the legacy `_idea` names remain accepted as
 * aliases — see ACTION_ALIAS — so an in-flight review block can't break on the rename):
 *   update_item  — patch a holding's fields in place (no broker touch)
 *   remove_item  — delete a NON-live holding doc (pending/waiting only)
 *   exit_item    — fully close a LIVE position across all its accounts
 *   trim_item    — partially close a LIVE position (reduceFraction of current size)
 *   add_item     — open a new holding: sized here, then handed to the order-confirm dialog
 *   add_to_item  — scale INTO a LIVE position (addFraction of current size)
 *   (swap = exit/trim + add in the same changes array)
 *
 * Per-leg sizing: every close/trim is computed per `brokerOrders[]` entry (account +
 * positionId), never on aggregate. Trim/exit only work on brokers whose
 * capabilities().closePosition is true (cTrader today; IBKR is not).
 *
 * After the moves: snapshot conviction (trajectory point), persist a thesis change if
 * the proposal carried one (reason 'accepted-rebalance'), and advance the review clock.
 */

import { getDb }                    from '../../providers/mongodb.provider.js'
import { PAST_ENTRY } from '../../services/entity/vocabulary.js'
import { logger }                   from '../../services/logger.service.js'
import { ideaService }              from '../trade-ideas/tradeIdeas.service.js'
import { brokerService }            from '../broker/broker.service.js'
import { portfolioChatService }     from './portfolioChat.service.js'
import { invalidatePortfolioState, computePortfolioState } from '../../services/portfolioState.service.js'
import { getNumericQuote }          from '../../providers/yahoofinance.provider.js'
import { notifyManualExit, notifyManualEntry, exitLegFromIdea, entryLegFromIdea } from '../../services/manualNotify.service.js'
import { ENTITIES }               from '../../services/entity/entityCollection.js'
import { orderSymbol }            from '../../monitoring/exitOrders.util.js'
import { deferIfClosed }          from '../../services/pendingAction/executionGate.js'

const LOG        = '[portfolio:rebalance]'
const COLLECTION = ENTITIES
const LIVE       = new Set(PAST_ENTRY)

/**
 * The hours gate, in the shape this file needs it.
 *
 * Every change below that reaches a broker asks this FIRST. A closed market no longer means "fire
 * anyway and let the paper venue fill it at yesterday's close" — the action is queued and the user
 * executes it from the list at the open (docs/architecture/off-hours-queue.md).
 *
 * `label` is stamped here rather than at the open because THIS is the only moment that knows the
 * item came from a review of this book. Manual books never reach it: they place no orders at all,
 * so their Fill card is an instruction rather than an execution and hours don't gate it.
 */
async function _gate(item, action) {
    return deferIfClosed({
        userId:     item.userId,
        asset:      item.asset,
        assetClass: item.asset_class ?? null,
        direction:  item.direction ?? null,
        origin: {
            kind:     'portfolio_item',
            entityId: item.id,
            ref:      item.portfolioId ?? null,
            label:    `${item.portfolioName || 'Portfolio'} review`,
        },
        action,
    })
}

/** The shared answer a change gives when the gate parked it — accepted, not executed, not failed. */
const _deferred = (gate, extra = {}) => ({
    ok: gate.ok !== false, deferred: true, queuedId: gate.id ?? null,
    nextOpenMs: gate.nextOpenMs ?? null,
    ...(gate.ok === false ? { reason: gate.reason ?? 'queue_failed' } : {}),
    ...extra,
})

export async function applyRebalance(portfolioId, userId, update) {
    if (!portfolioId) return { ok: false, reason: 'missing_portfolioId' }
    if (!update || !Array.isArray(update.changes) || update.changes.length === 0) {
        return { ok: false, reason: 'no_changes' }
    }

    // Sizing base for any NEW holding, measured ONCE up front. A review that exits or trims in the
    // same block must not shrink the base its own adds are sized against — and a leg closed a
    // moment ago still shows in the broker's position list, so reading it per-change would make the
    // size depend on change order and fill latency. Skipped entirely when nothing is being added.
    const adds = update.changes.some(c => (ACTION_ALIAS[c.action] ?? c.action) === 'add_item')
    const bookValue = adds ? await _bookValue(portfolioId, userId) : null

    const results = []
    const manualExitLegs  = []   // manual close/trim legs → one exit Fill card
    const manualEntryLegs = []   // manual add (scale-in) + new-holding legs → one entry Fill card
    for (const change of update.changes) {
        try {
            const r = await _applyOne(portfolioId, userId, change, bookValue)
            if (r?.manualExitLeg)  manualExitLegs.push(r.manualExitLeg)
            if (r?.manualEntryLeg) manualEntryLegs.push(r.manualEntryLeg)
            results.push({ action: change.action, itemId: change.itemId ?? change.ideaId ?? null, ...r })
        } catch (err) {
            logger.error(LOG, `change failed (${change.action})`, err.message)
            results.push({ action: change.action, itemId: change.itemId ?? change.ideaId ?? null, ok: false, error: err.message })
        }
    }

    // Manual mode: the user reports real fills, so close/trim legs post ONE N-leg exit Fill card and
    // entry legs (a scale-in or a brand-new holding) post ONE entry Fill card (the confirm endpoints
    // apply each as its price is submitted) instead of placing broker orders. See manual-mode.md §4b.
    let manualExitPosted = false, manualEntryPosted = false
    if (manualExitLegs.length || manualEntryLegs.length) {
        const db  = await getDb()
        const sib = await db.collection(COLLECTION).findOne({ portfolioId, userId }, { projection: { portfolioName: 1 } })
        const portfolioName = sib?.portfolioName ?? null
        if (manualExitLegs.length) {
            await notifyManualExit(userId, { portfolioId, portfolioName, reason: 'rebalance', legs: manualExitLegs })
            manualExitPosted = true
        }
        if (manualEntryLegs.length) {
            await notifyManualEntry(userId, { portfolioId, portfolioName, legs: manualEntryLegs })
            manualEntryPosted = true
        }
    }

    // THREE outcomes, not two. A change that the market couldn't take is neither applied nor
    // failed — it is queued, and saying so is the difference between "Changes applied" over a
    // no-op and "3 changes queued for the open".
    // `deferred && ok:false` is a change whose QUEUE WRITE failed — the market was shut and the row
    // was lost, so the decision is gone. That is a failure, not a queued item, and must not be
    // counted in both buckets (which would let a review complete on nothing but lost rows).
    const deferred = results.filter(r => r?.deferred && r?.ok !== false)
    const failed   = results.filter(r => !r?.ok)
    const applied  = results.filter(r => r?.ok && !r?.deferred)

    // Nothing landed and nothing queued → the review was NOT carried out. Refuse, so the caller
    // keeps the proposal for a retry (the FE already does exactly that on a falsy result) and the
    // clock does not advance over work that never happened.
    if (!applied.length && !deferred.length) {
        logger.warn(LOG, 'rebalance applied NOTHING', { portfolioId, reasons: failed.map(f => f.reason ?? f.error ?? '?') })
        return { ok: false, reason: 'nothing_applied', results, failed }
    }

    // Trajectory point, then deliberate thesis update (if any), then advance the clock.
    await snapshotConvictions(portfolioId, userId)
    if (update.thesis && typeof update.thesis === 'object') {
        await portfolioChatService.setThesis(portfolioId, userId, update.thesis, 'accepted-rebalance')
    }
    // The review itself IS done even when every change is queued — the decisions were taken, and
    // the queue owns their execution from here. Only a total failure (above) leaves it open.
    const rev = await portfolioChatService.completeReview(portfolioId, userId)
    invalidatePortfolioState(portfolioId, userId)

    logger.info(LOG, 'rebalance applied', {
        portfolioId, applied: applied.length, deferred: deferred.length, failed: failed.length,
        manualExitPosted, manualEntryPosted,
    })
    return {
        ok: true, results, manualExitPosted, manualEntryPosted,
        nextReviewAt: rev?.nextReviewAt ?? null,
        // The counts the UI speaks from; `deferredItems` carries enough to name them in the toast.
        applied:  applied.length,
        failed:   failed.map(f => ({ action: f.action, itemId: f.itemId, reason: f.reason ?? f.error ?? 'failed' })),
        deferredItems: deferred.map(d => ({ action: d.action, itemId: d.itemId, queuedId: d.queuedId ?? null })),
        nextOpenMs: deferred.find(d => d.nextOpenMs != null)?.nextOpenMs ?? null,
    }
}

// A holding is a `portfolio_item`, so the vocabulary is `_item`. The legacy `_idea` verbs are still
// accepted (a review block built before the rename, or an FE not yet updated) — normalized here.
const ACTION_ALIAS = {
    update_idea: 'update_item', remove_idea: 'remove_item', exit_idea: 'exit_item',
    trim_idea:   'trim_item',   add_idea:    'add_item',    add_to_idea: 'add_to_item',
}

async function _applyOne(portfolioId, userId, change, bookValue = null) {
    const db     = await getDb()
    const action = ACTION_ALIAS[change.action] ?? change.action
    // Back-compat: the id/spec fields were `ideaId`/`idea` before the portfolio_item rename.
    const itemId = change.itemId ?? change.ideaId
    const spec   = change.item   ?? change.idea
    switch (action) {
        case 'update_item':
            return ideaService.updateIdea(itemId, change.patch ?? {}, userId)

        case 'remove_item': {
            const item = await db.collection(COLLECTION).findOne({ id: itemId }, { projection: { status: 1 } })
            if (item && LIVE.has(item.status)) return { ok: false, reason: 'live_use_exit_item' }
            return ideaService.deleteIdea(itemId, userId)
        }

        case 'exit_item':
            return _exitItem(db, itemId, userId, change.reason ?? 'rebalance')

        case 'trim_item':
            return _trimItem(db, itemId, userId, change)

        case 'add_item':
            return _addItem(db, portfolioId, userId, spec, bookValue)

        case 'add_to_item':
            return _addToItem(db, itemId, userId, change)

        default:
            return { ok: false, reason: 'unknown_action' }
    }
}

// Fully close every live leg of a holding. The execution reconciler finalizes the
// idea to 'closed' as the broker reports the closes.
// Exported since 2026-08-07: the queue replays a released exit through the SAME function that
// first tried it, so an off-hours decision executes on exactly the path it would have taken had
// the market been open — not a second implementation that can drift from this one.
export async function _exitItem(db, itemId, userId, reason, gate = _gate) {
    const item = await db.collection(COLLECTION).findOne({ id: itemId })
    if (!item) return { ok: false, reason: 'not_found' }
    if (item.userId && item.userId !== userId) return { ok: false, reason: 'forbidden' }

    const legs = (item.brokerOrders ?? []).filter(b => b.positionId != null)
    if (legs.length === 0) return { ok: false, reason: 'no_position' }

    // Manual: can't place a broker close — hand the exit leg back so applyRebalance posts
    // ONE Fill card; the user confirms the real exit price (confirmManualExit finalizes it).
    if (legs.some(l => l.broker === 'manual')) {
        await db.collection(COLLECTION).updateOne({ id: itemId }, { $set: { pendingCloseReason: reason } })
        return { ok: true, manual: true, manualExitLeg: exitLegFromIdea(item) }
    }

    // Hours gate AFTER the manual branch (nothing is placed there) and BEFORE the first close.
    const g = await gate(item, { type: 'exit', reason })
    if (g.deferred) return _deferred(g)

    let closed = 0, skipped = 0
    for (const leg of legs) {
        if (!brokerService.capabilities(leg.broker)?.closePosition) { skipped++; continue }
        await brokerService.closePosition(leg.broker, userId, leg.accountId, leg.positionId)
        closed++
    }
    await db.collection(COLLECTION).updateOne({ id: itemId }, { $set: { pendingCloseReason: reason } })
    return { ok: closed > 0, legsClosed: closed, legsSkipped: skipped }
}

// Partially close a holding: close `reduceFraction` of each leg's volume. Records the
// new intended weight (targetAllocationRatio) but leaves quantity to the broker truth
// (the reconciler reconciles the reduce). targetAllocationRatio is advisory only.
// `broker` is injectable for the same reason `_addToItem`'s is: without it a test can only assert
// that the trim REFUSED, never what a successful one records. Appended rather than slotted in
// beside the others so every existing caller (and the queue's replay) keeps its argument positions.
export async function _trimItem(db, itemId, userId, change, gate = _gate, broker = brokerService) {
    const item = await db.collection(COLLECTION).findOne({ id: itemId })
    if (!item) return { ok: false, reason: 'not_found' }
    if (item.userId && item.userId !== userId) return { ok: false, reason: 'forbidden' }

    const f = Number(change.reduceFraction)
    if (!(f > 0 && f < 1)) return { ok: false, reason: 'bad_reduceFraction' }

    const legs = (item.brokerOrders ?? []).filter(b => b.positionId != null)
    if (legs.length === 0) return { ok: false, reason: 'no_position' }

    // Manual: no broker to hit — hand the trim back as a PARTIAL exit leg so applyRebalance posts a
    // Fill card. confirmManualExit reduces the position (not full close) using the reported size, or the
    // pendingTrimQty stamped here if the FE doesn't forward a quantity. Stamp both so the confirm is
    // robust. (A manual holding is a single manual leg.)
    if (legs.some(l => l.broker === 'manual')) {
        const leg     = legs.find(l => l.broker === 'manual')
        const openQty = leg.quantity ?? item.quantity ?? 0
        const trimQty = Math.floor(openQty * f)
        if (trimQty <= 0) return { ok: false, reason: 'trim_too_small' }
        await db.collection(COLLECTION).updateOne({ id: itemId }, { $set: { pendingCloseReason: 'trim', pendingTrimQty: trimQty } })
        return { ok: true, manual: true, manualExitLeg: {
            ideaId:       item.id,
            asset:        item.asset,
            direction:    item.direction,
            positionId:   leg.positionId,
            quantity:     trimQty,
            partial:      true,
            remainingQty: openQty - trimQty,
        } }
    }

    const g = await gate(item, { type: 'trim', reduceFraction: f, targetAllocationRatio: change.targetAllocationRatio ?? null })
    if (g.deferred) return _deferred(g)

    let trimmed = 0, skipped = 0
    for (const leg of legs) {
        if (!broker.capabilities(leg.broker)?.closePosition) { skipped++; continue }
        const qty = Math.floor((leg.quantity ?? 0) * f)
        if (qty <= 0) { skipped++; continue }
        await broker.closePosition(leg.broker, userId, leg.accountId, leg.positionId, { quantity: qty })
        // Write the reduction down. Without this the leg keeps its pre-trim size forever: a review
        // trim places no tracked exit order, and that is exactly the case the reconciler says it
        // cannot size — so the number every later fraction is measured against reached NEITHER
        // writer. A holding recorded as 126 while 63 was held made the next "trim half" close it all.
        //
        // COMPARE-AND-SET on the size we just sized off. The paper venue emits its reduce
        // synchronously inside closePosition, so the reconciler may already have stamped this leg
        // from the broker's own volume — which is the authoritative answer, and a plain write here
        // would overwrite it with our arithmetic. Filtering on the old value means the late writer
        // simply matches nothing.
        const before = Number(leg.quantity) || 0
        await db.collection(COLLECTION).updateOne(
            { id: itemId },
            { $set: { 'brokerOrders.$[leg].quantity': Math.max(0, before - qty) } },
            { arrayFilters: [{ 'leg.positionId': leg.positionId, 'leg.quantity': before }] },
        )
        trimmed++
    }
    if (trimmed) await _syncItemQuantity(db, itemId)

    if (change.targetAllocationRatio != null && Number.isFinite(Number(change.targetAllocationRatio))) {
        await db.collection(COLLECTION).updateOne({ id: itemId }, { $set: { allocationRatio: Number(change.targetAllocationRatio) } })
    }
    // Every leg rounded to nothing is a REFUSAL, not a quiet success. `floor(qty * fraction)` is 0
    // for any fraction under 1/qty — a 12% trim of an 8-share leg — and reporting ok:false with no
    // reason is what let a whole review land as "Changes applied" having done nothing at all.
    if (!trimmed && skipped) return { ok: false, reason: 'trim_too_small', legsSkipped: skipped }
    return { ok: trimmed > 0, legsTrimmed: trimmed, legsSkipped: skipped }
}

/**
 * Open a NEW holding in the portfolio, and put it in front of the user as an order.
 *
 * A review's add is a decision to enter NOW: the book being reviewed is already live, so a plain
 * 'waiting' doc would sit there until somebody separately re-activated the whole book — the
 * accepted recommendation would silently never trade. So the new holding enters through the SAME
 * path a "go in at market" idea takes (saveIdea's `immediate` → _attachImmediatePlan): status
 * 'hit' + `pendingOrder.plan` from buildOrderPlanForIdea + orderState 'awaiting_confirm', which is
 * exactly what surfaces the OrderConfirmDialog. Nothing is placed here — the user confirms, and
 * POST /api/trade-ideas/:id/orders → placeOrdersForIdea does the placing (and with it the exit
 * routing, reconciler linkage and double-place guard we'd lose by calling placeOrder directly).
 * Market closed → the plan parks as 'awaiting_market' and the market-open sweep
 * (monitoring/marketOpen.monitor.js) surfaces it at the open.
 *
 * Sizing: Atlas emits a WEIGHT, never a share count (the same contract construction has, where
 * _sizePlan does the arithmetic) — so the quantity is computed here from the book's live value.
 * An explicit `spec.quantity` still wins.
 *
 * Manual (broker-less) books have nothing to plan against: mirror activateManualPortfolio — mark
 * the leg awaiting the user's reported fill and hand it back so applyRebalance posts ONE entry
 * Fill card for the whole accepted block.
 *
 * `deps` is injectable for tests. Exported for the same reason.
 */
export async function _addItem(db, portfolioId, userId, spec, bookValue = null, deps = {}) {
    const {
        saveItem   = ideaService.saveIdea,
        updateItem = ideaService.updateIdea,
        quote      = getNumericQuote,
    } = deps

    if (!spec?.asset) return { ok: false, reason: 'no_asset' }

    // Inherit the book's identity + execution binding. Read the whole sibling set rather than one
    // doc: `broker` is what tells us this is a manual book, and one arbitrary sibling could be the
    // wrong partition of a forked (multi-broker) book.
    const siblings = await db.collection(COLLECTION)
        .find({ portfolioId, userId }, { projection: { asset: 1, direction: 1, status: 1, portfolioName: 1, accounts: 1, mainAccountId: 1, broker: 1 } })
        .toArray()
    const base     = siblings[0] ?? null
    const isManual = siblings.some(s => s.broker === 'manual')

    // add_item on a name the book already holds would open a SECOND position in it — which now
    // means a real duplicate order, not just a stray doc. add_to_item is how you grow a holding.
    // Matched on direction too, so a deliberate opposite-side leg isn't blocked.
    if (siblings.some(s => _sameHolding(s, spec))) return { ok: false, reason: 'already_held_use_add_to_item' }

    const quantity = await _sizeNewItem(spec, bookValue, quote)

    const res = await saveItem({
        ...spec,
        ...(quantity != null ? { quantity } : {}),
        // A manual book can't carry a broker order plan — it goes through the Fill card below.
        // Set explicitly either way: a spec that carried its own `immediate` must never decide this.
        immediate: !isManual,
        portfolioId,
        portfolioName: base?.portfolioName ?? spec.portfolioName ?? null,
        accounts:      Array.isArray(base?.accounts) ? base.accounts : [],
        mainAccountId: base?.mainAccountId ?? null,
    }, userId)
    if (!res?.ok) return { ok: false, reason: 'save_failed' }

    const items  = (Array.isArray(res.ideas) && res.ideas.length) ? res.ideas : [res.idea].filter(Boolean)
    const itemId = res.idea?.id ?? null
    if (!items.length) return { ok: false, reason: 'save_failed' }

    if (isManual) {
        // A manual book is a single manual partition, so there is exactly one leg to report.
        const item = items[0]
        await db.collection(COLLECTION).updateOne(
            { id: item.id },
            { $set: { status: 'hit', entryTriggeredAt: Date.now(), orderState: 'awaiting_manual_fill' } },
        )
        logger.info(LOG, 'new holding awaiting manual fill', { itemId: item.id, asset: item.asset, quantity: item.quantity ?? null })
        return { ok: true, itemId: item.id, manual: true, unsized: quantity == null && item.quantity == null, manualEntryLeg: entryLegFromIdea(item) }
    }

    // saveIdea already built the plan when the add is a straight market entry. If the spec carried
    // gating entry conditions, resolveImmediate refused the immediate path and saved it 'waiting'
    // instead — ARM it, so a conditional add is monitored from now rather than parked until the
    // book is re-activated. Either way the user still confirms before anything is placed — the
    // OrderConfirmDialog now.
    //
    // The conditional path has a sender again as of 2026-08-18: monitoring/entry.monitor.js, the
    // kind-blind entry loop. Between the deletion of the `idea` monitor that morning and that loop
    // the same afternoon, arming to 'looking' PARKED the add rather than monitoring it — this line
    // promised a card nothing could send. It is a holding, so the loop selects it: kind-blind means
    // `portfolio_item` too, and only `setup` is left to Talos.
    const parked = items.filter(i => i.status === 'waiting')
    for (const i of parked) await updateItem(i.id, { status: 'looking' }, userId)

    const awaitingConfirm = items.some(i => i.orderState === 'awaiting_confirm')
    // A NEW holding takes its own deferral route: saveIdea's immediate plan parks at
    // orderState 'awaiting_market' when the venue is shut, and the market-open sweep surfaces it.
    // Different mechanism from the queue above (phase 2 merges them), but the SAME thing happened
    // as far as the user is concerned — so it reports as deferred rather than as applied. Calling
    // a parked order "applied" is the exact lie this pass exists to remove.
    const awaitingMarket = items.some(i => i.orderState === 'awaiting_market')
    logger.info(LOG, `new holding ${awaitingMarket ? 'parked for the open' : 'opened for confirmation'}`, {
        itemId, asset: items[0].asset, quantity: items[0].quantity ?? null,
        legs: items.length, armed: parked.length, awaitingConfirm, awaitingMarket,
    })
    return {
        ok: true,
        itemId,
        ...(items.length > 1 ? { itemIds: items.map(i => i.id) } : {}),
        ...(awaitingMarket ? { deferred: true, queuedId: null } : {}),
        armed:          parked.length > 0,
        awaitingConfirm,
        orderState:     items[0].orderState ?? null,
        // No resolvable accounts → buildOrderPlan returns [] and there is nothing to confirm. The
        // holding is recorded, but say so rather than implying an order is waiting.
        planned:        items.some(i => i.pendingOrder?.plan?.length > 0),
        unsized:        quantity == null && items[0].quantity == null,
    }
}

// Is this existing holding the same exposure the spec wants to open? A closed holding doesn't
// count — re-entering a name the book has been out of is a legitimate add.
function _sameHolding(held, spec) {
    if (!held?.asset || held.status === 'closed') return false
    const dir = d => String(d ?? 'long').toLowerCase()
    return String(held.asset).toUpperCase() === String(spec.asset).toUpperCase()
        && dir(held.direction) === dir(spec.direction)
}

/**
 * Re-derive a holding's own `quantity` from its legs, after a trim or a scale-in changed them.
 *
 * `quantity` is the holding's size in IDEA UNITS — the number a single account carries — not the sum
 * across a multi-account book (saveIdea stamps the same figure on each account's leg). So it is read
 * off the MAIN account, summing that account's legs because a hedging scale-in can leave two.
 * Accounts other than the main one are left to their own leg quantities, which is where every
 * per-account calculation already reads from.
 *
 * Called from the two review paths that move real size. The reconciler deliberately does NOT do
 * this: it runs for every kind, and `quantity` on a call or a setup is the desk's number, not
 * something a fill should quietly rewrite.
 */
async function _syncItemQuantity(db, itemId) {
    try {
        const item = await db.collection(COLLECTION).findOne(
            { id: itemId },
            { projection: { brokerOrders: 1, mainAccountId: 1 } },
        )
        const legs = (item?.brokerOrders ?? []).filter(b => b.positionId != null)
        if (!legs.length) return
        // No mainAccountId (a book saved before it existed) → the first linked leg's account speaks
        // for the holding, which is the same fallback _deriveWorkspace makes.
        const acct  = String(item.mainAccountId ?? legs[0].accountId)
        const mine  = legs.filter(l => String(l.accountId) === acct)
        const total = (mine.length ? mine : legs).reduce((s, l) => s + (Number(l.quantity) || 0), 0)
        if (!(total > 0)) return
        await db.collection(COLLECTION).updateOne({ id: itemId }, { $set: { quantity: total } })
    } catch (err) {
        // Advisory: the legs are the load-bearing record, and this is the holding's display size.
        logger.warn(LOG, `quantity resync failed for ${itemId}`, err.message)
    }
}

/**
 * The book's live market value — the capital base a new holding's weight is sized against.
 * Never throws: an unavailable book value just leaves the add unsized (recorded, not sized).
 */
async function _bookValue(portfolioId, userId) {
    try {
        const state = await computePortfolioState(portfolioId, userId)
        const value = Number(state?.totalNotional)
        return value > 0 ? value : null
    } catch (err) {
        logger.warn(LOG, 'book value unavailable — new holdings will be unsized', err.message)
        return null
    }
}

/**
 * Share count for a new holding: floor(bookValue × allocationRatio / livePrice), the same
 * arithmetic construction does in portfolio.agent.service `_sizePlan` (there the base is the
 * plan's positionSize; at review time the only base that exists is what the book is worth now).
 * A sub-1 result rounds up to 1, as it does there. Returns null when it can't be computed —
 * the caller records the holding unsized rather than inventing a size.
 */
async function _sizeNewItem(spec, bookValue, quote) {
    const explicit = Number(spec.quantity)
    if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit)

    const ratio = Number(spec.allocationRatio)
    if (!(ratio > 0) || !(bookValue > 0)) return null

    let price = null
    try {
        price = Number((await quote(spec.asset))?.price)
    } catch (err) {
        logger.warn(LOG, `sizing: price fetch failed for ${spec.asset}`, err.message)
        return null
    }
    if (!(price > 0)) return null

    const raw = Math.floor((bookValue * ratio) / price)
    return raw > 0 ? raw : 1
}

/**
 * Scale INTO a live holding: a same-direction market order per leg, to increase exposure. A new name
 * uses add_item (a fresh holding); this grows one that is already on.
 *
 * The order carries `increasePositionId` — "grow THIS position" — and what comes back says how the
 * venue actually took it (see broker.interface):
 *
 *   • echoed the same positionId → the venue NETTED (paper, manual, a netting live broker). There is
 *     no new leg; the existing one is now bigger, and its recorded quantity is raised to match.
 *   • a NEW positionId → a hedging venue (cTrader/MT5) could not net, so it opened a sibling
 *     position. That becomes a second leg on the same holding, which trim/exit already iterate and
 *     computePortfolioState already sums.
 *
 * Branching on the returned id rather than the broker's name is what keeps both venues correct
 * without this file knowing which is which. What it must NOT do either way is leave the leg's
 * `quantity` at the pre-add size: that number is the base the NEXT fraction is measured against.
 *
 * Portfolio holdings are review-managed (no native stop/TP), so there are no protective exits to
 * grow here. `broker` is injectable for tests. targetAllocationRatio is advisory.
 * LIMITATION: a holding that DOES carry native exits won't have them resized here.
 */
export async function _addToItem(db, itemId, userId, change, broker = brokerService, gate = _gate) {
    const item = await db.collection(COLLECTION).findOne({ id: itemId })
    if (!item) return { ok: false, reason: 'not_found' }
    if (item.userId && item.userId !== userId) return { ok: false, reason: 'forbidden' }
    if (!LIVE.has(item.status)) return { ok: false, reason: 'not_live' }   // not in position → use add_item

    const f = Number(change.addFraction)
    if (!(f > 0)) return { ok: false, reason: 'bad_addFraction' }

    const legs = (item.brokerOrders ?? []).filter(b => b.positionId != null)
    if (legs.length === 0) return { ok: false, reason: 'no_position' }

    // Manual: no broker to hit — hand the add back as an entry leg so applyRebalance posts a Fill card.
    // confirmManualAdd grows the live position using the reported size, or the pendingAddQty stamped
    // here. (Unlike trim, an add can't reuse the entry-confirm endpoint — the FE must route add legs to
    // /:id/manual-add; the stamp still records intent. A manual holding is a single manual leg.)
    if (legs.some(l => l.broker === 'manual')) {
        const leg    = legs.find(l => l.broker === 'manual')
        const addQty = Math.floor((leg.quantity ?? item.quantity ?? 0) * f)
        if (addQty <= 0) return { ok: false, reason: 'add_too_small' }
        await db.collection(COLLECTION).updateOne({ id: itemId }, { $set: { pendingAddQty: addQty } })
        return { ok: true, manual: true, manualEntryLeg: {
            ideaId:    item.id,
            asset:     item.asset,
            direction: item.direction,
            quantity:  addQty,
            add:       true,
        } }
    }

    // The path that started all this: this used to place a market order with no idea whether the
    // market was open, and the paper venue filled it at the previous close without complaint.
    const g = await gate(item, { type: 'add_to', addFraction: f, targetAllocationRatio: change.targetAllocationRatio ?? null })
    if (g.deferred) return _deferred(g)

    const direction = item.direction === 'short' ? 'short' : 'long'
    const symbol    = orderSymbol(item)

    let added = 0, skipped = 0, failed = 0
    const newLegs = []   // hedging venue: a sibling position to track as its own leg
    const grown   = []   // netting venue: an existing leg whose size went up in place
    for (const leg of legs) {
        if (!broker.capabilities(leg.broker)?.trading) { skipped++; continue }
        const qty = Math.floor((leg.quantity ?? 0) * f)
        if (qty <= 0) { skipped++; continue }
        // Per-leg guard (mirrors placeOrdersForIdea): a failure on one account must NOT abandon a
        // sibling leg whose order already went in unlinked — each success is collected independently.
        try {
            const res = await broker.placeOrder(leg.broker, userId, leg.accountId, {
                symbol, direction, quantity: qty, type: 'market',
                // "Grow this one." A netting venue obliges and blends the average; a hedging one
                // ignores it and hands back a new position. Either answer is handled below.
                increasePositionId: leg.positionId,
            })
            const netted = res?.positionId != null && String(res.positionId) === String(leg.positionId)
            if (netted) {
                grown.push({ positionId: leg.positionId, before: Number(leg.quantity) || 0, quantity: (Number(leg.quantity) || 0) + qty })
            } else {
                newLegs.push({
                    broker:     leg.broker,
                    accountId:  res?.accountId  ?? leg.accountId,
                    orderId:    res?.orderId    ?? null,
                    positionId: res?.positionId ?? null,
                    quantity:   qty,
                })
            }
            added++
        } catch (err) {
            logger.error(LOG, `add leg failed (${leg.broker}/${leg.accountId})`, err.message)
            failed++
        }
    }

    if (added) {
        // Link the new legs so the reconciler backfills their positionId on fill (matched by orderId),
        // and make sure we're listening for those fills.
        if (newLegs.length) {
            await db.collection(COLLECTION).updateOne({ id: itemId }, { $push: { brokerOrders: { $each: newLegs } } })
            for (const l of newLegs) broker.startExecutionFeed?.(l.broker, userId, l.accountId)?.catch?.(() => {})
        }
        // A netted add created no leg — it made one bigger. Raise its recorded size, or every later
        // fraction is measured against a position that no longer exists at that size. Guarded on the
        // size we sized off, like the trim's write: whoever wrote in between (a reconciler stamping
        // the broker's own volume) knows better than this arithmetic does.
        for (const g of grown) {
            await db.collection(COLLECTION).updateOne(
                { id: itemId },
                { $set: { 'brokerOrders.$[leg].quantity': g.quantity } },
                { arrayFilters: [{ 'leg.positionId': g.positionId, 'leg.quantity': g.before }] },
            )
        }
        await _syncItemQuantity(db, itemId)
        // Record the intended new weight (advisory) only when exposure actually changed.
        if (change.targetAllocationRatio != null && Number.isFinite(Number(change.targetAllocationRatio))) {
            await db.collection(COLLECTION).updateOne({ id: itemId }, { $set: { allocationRatio: Number(change.targetAllocationRatio) } })
        }
    }
    // Same refusal as trim: a scale-in too small to round up to one share did not happen, and must
    // not read as though it did. This is the exact shape of the MU add that reported success.
    if (!added && skipped && !failed) return { ok: false, reason: 'add_too_small', legsSkipped: skipped }
    return { ok: added > 0, legsAdded: added, legsSkipped: skipped, ...(failed ? { legsFailed: failed } : {}) }
}

// Append a conviction snapshot to each holding so the next review can show the
// trajectory (current vs prior). Called on every review close (accept or dismiss).
export async function snapshotConvictions(portfolioId, userId) {
    try {
        const db = await getDb()
        const holdings = await db.collection(COLLECTION)
            .find({ portfolioId, userId }, { projection: { id: 1, conviction: 1 } })
            .toArray()
        const now = Date.now()
        for (const h of holdings) {
            if (!h.conviction) continue
            await db.collection(COLLECTION).updateOne(
                { id: h.id },
                { $push: { conviction_history: { $each: [{ at: now, level: h.conviction.level ?? null, score: h.conviction.score ?? null }], $slice: -12 } } },
            )
        }
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'snapshotConvictions failed', err.message)
        return { ok: false }
    }
}
