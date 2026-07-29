// ONE home for owner-scoped entity CRUD: list / read / patch / delete over the `entities`
// collection, scoped to a kind and guarded by the owner.
//
// Same split as vocabulary.js and the tool registry: the MECHANISM lives here, the JUDGMENT stays
// with the kind. Reading your own setups and reading your own calls is the same mechanism; whether
// a zone rewrite re-arms the monitor, which statuses a patch may set, and what a Generate gate
// requires are decisions that belong to setups.service / kairos.service and never move here.
//
// It replaced four hand-rolled copies of the same five operations (tradeIdeas, kairos, setups,
// coverage — each with its own getDb() → findOne → guard → stripId), which had already drifted:
//   • setups returned `not_found` when a doc existed but wasn't yours; ideas and calls returned
//     `forbidden`. Now every kind reports the two cases apart.
//   • the guard was re-typed at 9 sites as `doc.x && doc.x !== userId`.
//
// There is NO admin bypass. Cross-user visibility was disabled at the token (auth.middleware pins
// isAdmin=false), so every `isAdmin` branch below it was unreachable code that still had to be
// read as if it were live. An entity belongs to its owner, full stop.
//
// Separate from entityRepo (the EXECUTION facade: broker linkage, atomic claims, reconciler
// writes). Both target the same collection; this one is the API/list tier and is the only place
// that knows about owners and stripId.
//
// Not limited to `entities`: `coverage` is the Analyst's research artifact in its own collection
// with no `kind` and its own recency field, and it rides the same factory via { collection,
// sortBy }. Being owner-scoped is what qualifies a list here — not which collection it sits in.

import { getDb, stripId } from '../../providers/mongodb.provider.js'
import { logger }         from '../logger.service.js'
import { ENTITIES }       from './entityCollection.js'

/**
 * May this user act on this doc?
 *
 * An OWNERLESS doc passes: pre-cutover entities were written without an owner and must stay
 * manageable by whoever can reach them. That leniency is the reason `userId` is force-projected
 * below — a projection that omitted the field would make every doc look ownerless and silently
 * turn the guard off.
 */
export function ownsEntity(doc, userId) {
    if (!doc?.userId) return true
    return doc.userId === userId
}

/**
 * @param {Object}   cfg
 * @param {string|Object} [cfg.kind]   value matched against the `kind` field — a literal
 *   ('setup'), a mongo expression ({ $ne: 'call' }), or omitted (coverage has no kind).
 * @param {string}   [cfg.collection]  physical collection. Defaults to `entities`.
 * @param {Object}   [cfg.sortBy]      list order. Defaults to newest-first by `savedAt`;
 *   coverage orders by `updated_at` because a thesis's recency is when it was last revised.
 * @param {string[]} [cfg.deleteLock]  statuses that refuse a delete (→ reason 'in_position').
 * @param {string}   [cfg.log]         log tag, so failures still read as the caller's.
 * @param {Function} [cfg.coll]        collection provider — injected in tests.
 */
export function makeEntityCrud({
    kind, collection = ENTITIES, sortBy = { savedAt: -1 },
    deleteLock = [], log = '[entityCrud]', coll = null,
} = {}) {
    const locked     = new Set(deleteLock)
    const kindFilter = kind == null ? {} : { kind }
    const _coll      = coll ?? (async () => (await getDb()).collection(collection))

    /** Owner-scoped filter — a list is always and only the caller's own. */
    function _scope(userId) {
        return { ...kindFilter, userId }
    }

    return {
        kind,

        /**
         * The kind's list for this user, newest first, `_id` stripped.
         * `filter` adds caller-supplied criteria (e.g. { status }).
         * Returns [] on failure — a list surface degrades to empty rather than 500ing.
         */
        async list(userId, { filter = {} } = {}) {
            try {
                const c = await _coll()
                return (await c.find({ ..._scope(userId), ...filter })
                    .sort(sortBy)
                    .toArray())
                    .map(stripId)
            } catch (err) {
                logger.error(log, 'list failed', err)
                return []
            }
        },

        /**
         * One doc by id, ownership enforced — RAW (not stripped), for callers that go on to read
         * status / plan fields off it.
         *
         * `projection` always gains `userId`, so no caller can accidentally project the guard away.
         * @returns {Promise<{ok:true, doc:Object}|{ok:false, reason:string, error?:Error}>}
         */
        async getOwned(id, userId, { projection = null } = {}) {
            try {
                const c    = await _coll()
                const opts = projection ? { projection: { ...projection, userId: 1 } } : undefined
                const doc  = await c.findOne({ id, ...kindFilter }, opts)
                if (!doc) return { ok: false, reason: 'not_found' }
                if (!ownsEntity(doc, userId)) return { ok: false, reason: 'forbidden' }
                return { ok: true, doc }
            } catch (err) {
                logger.error(log, `getOwned failed for ${id}`, err)
                return { ok: false, reason: 'error', error: err }
            }
        },

        /** As getOwned, but STRIPPED — the shape an API response returns. */
        async getOwnedStripped(id, userId, opts = {}) {
            const res = await this.getOwned(id, userId, opts)
            return res.ok ? { ok: true, doc: stripId(res.doc) } : res
        },

        /**
         * Ownership-guarded `$set`, returning the updated doc (stripped). The guard is a read then
         * a write — fine here because every caller is a user-initiated edit, not a monitor race.
         * Concurrent lifecycle writes belong on entityRepo.claimIf, which is atomic.
         */
        async patchOwned(id, userId, $set) {
            const found = await this.getOwned(id, userId)
            if (!found.ok) return found
            try {
                const c = await _coll()
                const updated = await c.findOneAndUpdate(
                    { id, ...kindFilter }, { $set }, { returnDocument: 'after' },
                )
                if (!updated) return { ok: false, reason: 'not_found' }
                return { ok: true, doc: stripId(updated) }
            } catch (err) {
                logger.error(log, `patch failed for ${id}`, err)
                return { ok: false, reason: 'error', error: err }
            }
        },

        /**
         * Delete, ownership enforced and `deleteLock` respected. `onBeforeDelete(doc)` runs only
         * once the guards have passed — that is where a kind cleans up at the broker (cancelling
         * resting orders), so it can never fire for a delete that is about to be refused.
         */
        async remove(id, userId, { onBeforeDelete = null } = {}) {
            const found = await this.getOwned(id, userId)
            if (!found.ok) return found
            if (locked.has(found.doc.status)) return { ok: false, reason: 'in_position' }
            try {
                if (onBeforeDelete) await onBeforeDelete(found.doc)
                const c = await _coll()
                await c.deleteOne({ id, ...kindFilter })
                logger.info(log, `deleted ${id}`)
                return { ok: true }
            } catch (err) {
                logger.error(log, `delete failed for ${id}`, err)
                return { ok: false, reason: 'error', error: err }
            }
        },

        /** Insert a fully-built doc. Composition (id, defaults, stamps) stays with the kind. */
        async insert(doc) {
            const c = await _coll()
            await c.insertOne(doc)
            return stripId(doc)
        },
    }
}
