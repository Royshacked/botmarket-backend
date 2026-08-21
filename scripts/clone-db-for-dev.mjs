/**
 * Clone the shared database into a DEV database on the same cluster.
 *
 *   node scripts/clone-db-for-dev.mjs [targetDbName]      # default: botmarket_dev
 *
 * WHY. Until 2026-08-21 a laptop and the deployed instance used the SAME database, so they
 * contended for the one `background_loops` lease in `system_locks`. The deployed instance always
 * won, which made local dev a permanent FOLLOWER: no reconciler, no monitors. A paper fill executed
 * by the laptop went onto its own in-process executionBus with nothing listening — the position
 * moved, but nothing captured the trade, journalled it, or posted a card. See
 * docs/architecture/single-instance.md.
 *
 * Copies every collection AND its indexes. Refuses to overwrite a non-empty target unless --force,
 * and refuses to write to the source. Read-only against the source throughout.
 */
import dotenv from 'dotenv'
dotenv.config()

import { MongoClient, ServerApiVersion } from 'mongodb'

// slice(2) — argv[0] is the node binary's own path, which is not a database name.
const TARGET = process.argv.slice(2).find(a => !a.startsWith('-')) ?? 'botmarket_dev'
const FORCE  = process.argv.includes('--force')
const URI    = process.env.MONGODB_URI
if (!URI) { console.error('MONGODB_URI is not set'); process.exit(1) }

const client = new MongoClient(URI, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    family: 4,
})
await client.connect()

// The SOURCE is whatever the URI points at — deliberately not DB_NAME, so running this after you
// have already switched your .env still copies from the shared database rather than from itself.
const src = client.db()
const dst = client.db(TARGET)
if (src.databaseName === TARGET) {
    console.error(`refusing to clone "${TARGET}" onto itself`)
    await client.close(); process.exit(1)
}

const existing = await dst.listCollections().toArray()
if (existing.length && !FORCE) {
    console.error(`"${TARGET}" already has ${existing.length} collection(s). Re-run with --force to replace them.`)
    await client.close(); process.exit(1)
}

console.log(`cloning "${src.databaseName}" → "${TARGET}"\n`)
const cols = await src.listCollections().toArray()
let totalDocs = 0

for (const { name } of cols) {
    const docs = await src.collection(name).find({}).toArray()
    if (FORCE) await dst.collection(name).drop().catch(() => {})
    // An empty collection still gets created, so an index build below has something to attach to
    // and the app does not see a missing collection where the source had an empty one.
    if (docs.length) await dst.collection(name).insertMany(docs, { ordered: false })
    else await dst.createCollection(name).catch(() => {})

    // Indexes matter more than they look: `ensure*Indexes()` runs at boot, but a unique index that
    // the source has and the target lacks turns a duplicate into a silent second document.
    const idx = await src.collection(name).indexes()
    for (const { key, name: idxName, v, ...opts } of idx) {
        if (idxName === '_id_') continue
        await dst.collection(name).createIndex(key, { name: idxName, ...opts }).catch(err =>
            console.warn(`  ! index ${name}.${idxName}: ${err.message}`))
    }
    totalDocs += docs.length
    console.log(`  ${name.padEnd(28)} ${String(docs.length).padStart(6)} docs, ${idx.length - 1} index(es)`)
}

// The lease is per-database, and copying the deployed instance's live row would make the laptop
// think the lease is held by a process that will never renew it here — one TTL of pointless waiting
// on every boot. Drop it: an unheld lease is claimed immediately.
await dst.collection('system_locks').deleteOne({ _id: 'background_loops' }).catch(() => {})

console.log(`\ndone — ${cols.length} collections, ${totalDocs} documents.`)
console.log(`Now set DB_NAME=${TARGET} in your local .env and restart the server.`)
await client.close()
