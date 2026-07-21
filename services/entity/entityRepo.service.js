// The execution-path persistence facade (ENTITY_MODEL.md P1b). Owns the ONE place the backing
// collection is named + the ONE place the broker-linkage match shapes live, so P2 flips the
// target ('ideas' → 'entities', after migrating data) and every execution site follows.
//
// STRANGLER WINDOW: this deliberately targets the LEGACY `ideas` collection — calls execute via
// an idea shadow, portfolio holdings ARE ideas — so ACTIVE_STATUSES stays idea-vocab. P3 generalizes.
//
// BEHAVIOR-PRESERVING: every method reproduces the EXACT filter/update/options its caller used
// inline (see execution.reconciler.js), including String() coercion of account/position/order ids.
// Lookups return RAW docs (no stripId) because the reconciler operates on raw docs today.
//
// Separate from entityStore (which targets the FUTURE `entities` collection): during the
// transition these are two different physical collections.

import { getDb } from '../../providers/mongodb.provider.js'
import { ENTITIES } from './entityCollection.js'

/** The kind-blind entity store (P2 cutover done — was 'ideas'). */
export const EXEC_COLLECTION = ENTITIES
/** Idea-lifecycle "in a live position" set. P3 generalizes per kind. */
export const ACTIVE_STATUSES = ['long', 'short']

async function _defaultColl() {
    return (await getDb()).collection(EXEC_COLLECTION)
}

/** Reusable broker-linkage matcher — one entry per account, matched by (accountId, positionId). */
function _positionMatch(accountId, positionId) {
    return { $elemMatch: { accountId: String(accountId), positionId: String(positionId) } }
}

/**
 * @param {{ coll?: () => Promise<any> }} [deps]  inject a collection provider for tests.
 */
export function makeEntityRepo({ coll = _defaultColl } = {}) {
    return {
        // ── broker-linkage lookups (kind-blind) ─────────────────────────────────────────────
        /** The active entity holding this account+position in its entry linkage. */
        async findActiveByPosition(accountId, positionId) {
            const c = await coll()
            return c.findOne({
                status: { $in: ACTIVE_STATUSES },
                brokerOrders: _positionMatch(accountId, positionId),
            })
        },

        /** Any entity already linked to this account+position (linked-inline / re-delivery check). */
        async findLinkedByPosition(accountId, positionId) {
            const c = await coll()
            return c.findOne({ brokerOrders: _positionMatch(accountId, positionId) })
        },

        /**
         * Resting stop-entry fill: flip a 'resting' entity live and stamp the positionId onto its
         * matched order slot. `set` MUST include the `brokerOrders.$[slot].positionId` field — this
         * method supplies the matching `slot` arrayFilter. Returns the updated doc (or null).
         */
        async claimRestingFill(accountId, orderId, set) {
            const c = await coll()
            return c.findOneAndUpdate(
                {
                    status: 'resting',
                    brokerOrders: { $elemMatch: { accountId: String(accountId), orderId: String(orderId) } },
                },
                { $set: set },
                {
                    arrayFilters:   [{ 'slot.accountId': String(accountId), 'slot.orderId': String(orderId) }],
                    returnDocument: 'after',
                },
            )
        },

        /**
         * Backfill a positionId onto an active entity's unlinked order slot on this account
         * (optionally constrained to a symbol). Returns the updated doc (or null).
         */
        async backfillPositionId(accountId, positionId, symbol) {
            const c = await coll()
            const filter = {
                status: { $in: ACTIVE_STATUSES },
                brokerOrders: { $elemMatch: { accountId: String(accountId), positionId: null } },
            }
            if (symbol) filter.asset = symbol
            return c.findOneAndUpdate(
                filter,
                { $set: { 'brokerOrders.$[slot].positionId': String(positionId) } },
                {
                    arrayFilters:   [{ 'slot.accountId': String(accountId), 'slot.positionId': null }],
                    returnDocument: 'after',
                },
            )
        },

        /** Active + resting entities carrying broker links — for resuming execution feeds after restart. */
        async activeWithBrokerLinks() {
            const c = await coll()
            return c.find(
                { status: { $in: [...ACTIVE_STATUSES, 'resting'] }, brokerOrders: { $exists: true, $ne: [] } },
                { projection: { userId: 1, brokerOrders: 1 } },
            ).toArray()
        },

        // ── by-id lifecycle writes ──────────────────────────────────────────────────────────
        async getById(id) {
            const c = await coll()
            return c.findOne({ id })
        },

        /** Unconditional $set patch by id. */
        async patch(id, fields) {
            const c = await coll()
            return c.updateOne({ id }, { $set: fields })
        },

        /**
         * {id, ...guard} $set, returning the UPDATED doc (returnDocument:'after'). `guard` adds
         * extra filter fields (e.g. an ownership `{userId}`) — an empty guard is a plain {id} patch.
         */
        async patchAndGet(id, fields, guard = {}) {
            const c = await coll()
            return c.findOneAndUpdate({ id, ...guard }, { $set: fields }, { returnDocument: 'after' })
        },

        /** All entities whose status ∈ statuses (the monitor's poll query). Raw docs. */
        async listByStatus(statuses) {
            const c = await coll()
            return c.find({ status: { $in: statuses } }).toArray()
        },

        /** All entities in a given orderState (the deferred-order market sweep). Raw docs. */
        async listByOrderState(orderState) {
            const c = await coll()
            return c.find({ orderState }).toArray()
        },

        /**
         * Guarded single-winner claim: findOneAndUpdate({id, ...guard}, $set fields) with the DEFAULT
         * returnDocument (pre-image) — truthy iff the guard held and this call won the race.
         */
        async claimIf(id, guard, fields) {
            const c = await coll()
            return c.findOneAndUpdate({ id, ...guard }, { $set: fields })
        },

        /** All entities under a portfolio book (optionally scoped to a user). Raw docs. */
        async listByPortfolio(portfolioId, userId) {
            const c = await coll()
            const filter = { portfolioId }
            if (userId != null) filter.userId = userId
            return c.find(filter).toArray()
        },

        /** Bulk {id ∈ ids} $set. */
        async patchMany(ids, fields) {
            const c = await coll()
            return c.updateMany({ id: { $in: ids } }, { $set: fields })
        },

        /** Generic raw update by id — for the mixed $set/$addToSet/$push the monitor composes. */
        async update(id, updateDoc) {
            const c = await coll()
            return c.updateOne({ id }, updateDoc)
        },

        /**
         * Flip to closed only if still active (so a concurrent close wins once). Returns the updated
         * doc, or null when someone else closed it first.
         */
        async finalizeClose(id, patch) {
            const c = await coll()
            return c.findOneAndUpdate(
                { id, status: { $in: ACTIVE_STATUSES } },
                { $set: patch },
                { returnDocument: 'after' },
            )
        },

        /**
         * Atomically claim an account for exit-order placement. `$addToSet` under a `$ne` filter is
         * atomic — only the first caller matches. Returns true iff THIS call won the claim.
         */
        async claimExitAccount(id, acct) {
            const c = await coll()
            const res = await c.updateOne(
                { id, exitPlacedAccounts: { $ne: String(acct) } },
                { $addToSet: { exitPlacedAccounts: String(acct) } },
            )
            return res.modifiedCount > 0
        },

        async pushExitOrders(id, orders) {
            const c = await coll()
            return c.updateOne({ id }, { $push: { exitOrders: { $each: orders } } })
        },

        async setExitOrders(id, orders) {
            const c = await coll()
            return c.updateOne({ id }, { $set: { exitOrders: orders } })
        },
    }
}

/** Default singleton over the current execution backing collection. */
export const entityRepo = makeEntityRepo()
