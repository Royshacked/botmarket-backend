// A small in-memory Mongo — enough for the Pythia services' tests (assessments, calls, themes, metrics
// reads). Supports: equality and `$ne` / `$in` filters on dotted paths; find().sort().limit().next/toArray;
// findOne; insertOne; replaceOne and updateOne with upsert, $setOnInsert, $set (dotted) and $push with
// $each/$position; createIndex as a no-op. `rows(name)` exposes a collection's documents for assertions.

function _get(o, path) { return path.split('.').reduce((x, k) => (x == null ? x : x[k]), o) }
function _setPath(o, path, v) { const ks = path.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = (x[k] ??= {}); x[ks.at(-1)] = v }
function _match(doc, q) {
    return Object.entries(q).every(([k, v]) => {
        if (v && typeof v === 'object' && '$ne' in v) return (_get(doc, k) ?? null) !== v.$ne
        if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(_get(doc, k))
        return JSON.stringify(_get(doc, k)) === JSON.stringify(v)
    })
}

export function memDb() {
    const cols = {}
    const col = (name) => {
        const rows = (cols[name] ??= [])
        const cursor = (list) => {
            let out = [...list]
            const c = {
                sort: (spec) => { const [[k, dir]] = Object.entries(spec); out.sort((a, b) => (_get(a, k) > _get(b, k) ? 1 : -1) * dir); return c },
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
                if (!doc && upsert) { doc = { ...q, ...(u.$setOnInsert ?? {}) }; rows.push(doc) }
                if (!doc) return { matchedCount: 0 }
                for (const [k, v] of Object.entries(u.$set ?? {})) _setPath(doc, k, structuredClone(v))
                for (const [k, v] of Object.entries(u.$push ?? {})) { const arr = (_get(doc, k) ?? []); arr.splice(v.$position ?? arr.length, 0, ...v.$each); _setPath(doc, k, arr) }
                return { matchedCount: 1 }
            },
            createIndex: async () => {},
        }
    }
    const db = { collection: (n) => col(n) }
    return { db, rows: (n) => col(n).rows }
}
