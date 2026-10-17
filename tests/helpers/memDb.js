// A small in-memory Mongo — enough for the Pythia services' and the session store's tests. Supports:
// equality (null also matching a missing field, as in Mongo) and `$ne` / `$in` / `$exists` / `$gt` / `$lt`
// filters on dotted paths, and a top-level `$or`; multi-key sort; find().sort().limit().next/toArray; skip; findOne;
// insertOne; deleteMany; replaceOne and updateOne with upsert, $setOnInsert, $set (dotted), $inc and
// $push (one value, or $each/$position); findOneAndUpdate (returns the document AFTER); createIndex as
// a no-op — unique indexes are NOT enforced. `rows(name)` exposes a collection's documents for assertions.

function _get(o, path) { return path.split('.').reduce((x, k) => (x == null ? x : x[k]), o) }
function _setPath(o, path, v) { const ks = path.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = (x[k] ??= {}); x[ks.at(-1)] = v }
function _match(doc, q) {
    return Object.entries(q).every(([k, v]) => {
        if (k === '$or') return v.some(sub => _match(doc, sub))
        if (v && typeof v === 'object' && '$ne' in v) return (_get(doc, k) ?? null) !== v.$ne
        if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(_get(doc, k))
        if (v && typeof v === 'object' && '$exists' in v) return (_get(doc, k) !== undefined) === Boolean(v.$exists)
        if (v && typeof v === 'object' && '$gt' in v) return _get(doc, k) > v.$gt
        if (v && typeof v === 'object' && '$lt' in v) return _get(doc, k) < v.$lt
        // Mongo: { field: null } matches a null field AND a missing one.
        if (v === null) return _get(doc, k) == null
        return JSON.stringify(_get(doc, k)) === JSON.stringify(v)
    })
}

// $push of one value, or of several with $each (and $position).
function _push(doc, spec) {
    for (const [k, v] of Object.entries(spec ?? {})) {
        const arr = (_get(doc, k) ?? [])
        const each = v && typeof v === 'object' && Array.isArray(v.$each) ? v.$each : [v]
        arr.splice(v?.$position ?? arr.length, 0, ...structuredClone(each))
        _setPath(doc, k, arr)
    }
}

// $set (dotted), $inc (dotted, missing counts as 0) and $push, in that order.
function _apply(doc, u) {
    for (const [k, v] of Object.entries(u.$set ?? {})) _setPath(doc, k, structuredClone(v))
    for (const [k, v] of Object.entries(u.$inc ?? {})) _setPath(doc, k, (_get(doc, k) ?? 0) + v)
    _push(doc, u.$push)
}

export function memDb() {
    const cols = {}
    const col = (name) => {
        const rows = (cols[name] ??= [])
        const cursor = (list) => {
            let out = [...list]
            const c = {
                // Every key, in order (latestRun sorts on two).
                sort: (spec) => {
                    const keys = Array.isArray(spec) ? spec : Object.entries(spec)
                    out.sort((a, b) => {
                        for (const [k, dir] of keys) {
                            const x = _get(a, k), y = _get(b, k)
                            if (x !== y) return (x > y ? 1 : -1) * dir
                        }
                        return 0
                    })
                    return c
                },
                skip: (n) => { out = out.slice(n); return c },
                limit: (n) => { out = out.slice(0, n); return c },
                next: async () => out[0] ?? null,
                toArray: async () => out,
            }
            return c
        }
        return {
            rows,
            findOne: async (q) => structuredClone(rows.find(r => _match(r, q)) ?? null),
            find: (q = {}) => cursor(rows.filter(r => _match(r, q)).map(r => structuredClone(r))),
            insertOne: async (d) => { rows.push(structuredClone(d)); return { acknowledged: true } },
            replaceOne: async (q, d, { upsert } = {}) => { const i = rows.findIndex(r => _match(r, q)); if (i >= 0) rows[i] = structuredClone(d); else if (upsert) rows.push(structuredClone(d)); return { matchedCount: i >= 0 ? 1 : 0 } },
            updateOne: async (q, u, { upsert } = {}) => {
                let doc = rows.find(r => _match(r, q))
                let upserted = 0
                if (!doc && upsert) { doc = { ...q, ...(u.$setOnInsert ?? {}) }; rows.push(doc); upserted = 1 }
                if (!doc) return { matchedCount: 0, upsertedCount: 0 }
                _apply(doc, u)
                return upserted ? { matchedCount: 0, upsertedCount: 1 } : { matchedCount: 1 }
            },
            // The returnDocument:'after' form only — what an atomic counter (a session's seq) needs.
            findOneAndUpdate: async (q, u) => {
                const doc = rows.find(r => _match(r, q))
                if (!doc) return null
                _apply(doc, u)
                return structuredClone(doc)
            },
            deleteMany: async (q) => { const keep = rows.filter(r => !_match(r, q)); const n = rows.length - keep.length; rows.splice(0, rows.length, ...keep); return { deletedCount: n } },
            createIndex: async () => {},
        }
    }
    const db = { collection: (n) => col(n) }
    return { db, rows: (n) => col(n).rows }
}
