// The write pipe under a HOUSE ARTIFACT — a standing view with no owner, kept as a publication log.
// Two of them today: the Analyst's `coverage` (one doc per symbol) and the strategy desk's `tilt`
// (one doc per benchmark). Each service owns its SCHEMA, its normaliser and its gates; what they
// were both writing out by hand, identically, is here.
//
// Two writes, and why they are shaped the way they are:
//
//   • revise    — the publication path. A revision is PREPENDED to the trail (newest first — the
//                 readers `.find` the latest) and the patched fields are set, in ONE update. Both
//                 services used to read the doc, rebuild `revisions` as a whole array in memory and
//                 `$set` it back beside every field of the merged document. Two writers in the same
//                 window — the monitor's verdict against an admin's edit, a refresh against either —
//                 and the second one landed a stale copy: a revision lost, or a price target the
//                 other writer had just moved written back to where it was. `$push` at position 0
//                 makes the trail append-only in the database and not merely by convention, and a
//                 caller that sets only what its patch touched cannot resurrect anything.
//   • recordMonitorState — the quiet path. The monitor's own bookkeeping under `monitor.*` (and the
//                 graded rows, for a tilt), with no revision: eleven grade refreshes a day would bury
//                 the trail that makes the view auditable. `set` is a flat map of dotted paths and/or
//                 top-level fields, `inc` the counters.
//
// The judgment stays with each service: what counts as a revision, which fields a patch may touch,
// what the monitor records. This is the pipe, not the policy. `getDb` is injectable so the shape of
// the update can be asserted against a fake collection.

import { getDb as _defaultGetDb } from '../providers/mongodb.provider.js'

/**
 * @param {{ collection: string, getDb?: () => Promise<import('mongodb').Db> }} cfg
 */
export function makeHouseArtifactRepo({ collection, getDb = _defaultGetDb }) {
    if (!collection) throw new Error('makeHouseArtifactRepo: collection is required')

    return {
        /**
         * Set the patched fields and prepend one revision, atomically → `{ ok }` (matched by id).
         * `$set` must NOT carry `revisions` — the trail is the `$push`'s, and passing both is a
         * conflict Mongo rejects; it is refused here with a clear message instead.
         */
        async revise(id, $set, revision) {
            if ($set && 'revisions' in $set) throw new Error('houseArtifactRepo.revise: the trail is appended, never set — drop `revisions` from $set')
            if (!revision || typeof revision !== 'object') throw new Error('houseArtifactRepo.revise: a revision is required')
            const db  = await getDb()
            // No `$set` at all when there is nothing to set — an EMPTY `$set: {}` is a no-op on
            // MongoDB 5+ and a rejected update on anything older.
            const update = { $push: { revisions: { $each: [revision], $position: 0 } } }
            if ($set && Object.keys($set).length) update.$set = $set
            const res = await db.collection(collection).updateOne({ id }, update)
            return { ok: res.matchedCount === 1 }
        },

        /** The monitor's bookkeeping write — no revision. → `{ ok }` (matched by id). */
        async recordMonitorState(id, { set = {}, inc = null } = {}) {
            const db     = await getDb()
            const update = { $set: set }
            if (inc) update.$inc = inc
            const res = await db.collection(collection).updateOne({ id }, update)
            return { ok: res.matchedCount === 1 }
        },
    }
}
