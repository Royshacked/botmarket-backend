// The kind-blind repository over the single `entities` collection. Services query/mutate entities
// through here without ever branching on kind. NO consumers yet (P0) — this is the storage seam
// P2–P4 migrate each kind onto. IO is injectable (a `coll` provider) so the query/filter logic is
// unit-testable against an in-memory fake, matching the Hermes `_deps` pattern.

import { getDb, stripId, stripIds } from '../../providers/mongodb.provider.js'

export const COLLECTION = 'entities'

/**
 * Build a Mongo filter from an entity query. Pure — undefined selectors are omitted so callers can
 * pass a sparse `{ kind, parentId, userId, status }` and only the present keys constrain.
 * `status` accepts a scalar or an array (→ `$in`), mirroring the monitors' status-set queries.
 */
export function buildFilter({ kind, parentId, userId, status } = {}) {
    const filter = {}
    if (kind     !== undefined) filter.kind     = kind
    if (parentId !== undefined) filter.parentId = parentId
    if (userId   !== undefined) filter.userId   = userId
    if (status   !== undefined) filter.status   = Array.isArray(status) ? { $in: status } : status
    return filter
}

async function _defaultColl() {
    return (await getDb()).collection(COLLECTION)
}

/**
 * @param {{ coll?: () => Promise<any> }} [deps]  inject a collection provider for tests.
 */
export function makeEntityStore({ coll = _defaultColl } = {}) {
    return {
        async getById(id) {
            const c = await coll()
            return stripId(await c.findOne({ id }))
        },
        async query(sel = {}) {
            const c = await coll()
            return stripIds(await c.find(buildFilter(sel)).toArray())
        },
        async insert(envelope) {
            const c = await coll()
            await c.insertOne(envelope)
            return envelope
        },
        async patch(id, fields) {
            const c = await coll()
            await c.updateOne({ id }, { $set: fields })
            return this.getById(id)
        },
        async remove(id) {
            const c = await coll()
            await c.deleteOne({ id })
        },
    }
}

/** Default singleton over the real `entities` collection. */
export const entityStore = makeEntityStore()
