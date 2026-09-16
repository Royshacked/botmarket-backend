import { MongoClient, ServerApiVersion } from 'mongodb'
import { logger } from '../services/logger.service.js'
import { config } from '../services/config.js'

const LOG = '[mongodb]'

let _client = null
let _db = null
// The connect IN FLIGHT, so concurrent first callers share one client. Cleared once it settles.
let _connecting = null

const _defaultClientFactory = (uri, options) => new MongoClient(uri, options)
let _createClient = _defaultClientFactory

/**
 * THE database handle — one client per process.
 *
 * "One" has to be enforced against the boot sequence, not assumed. server.js fires ten
 * `ensure*Indexes()` calls without awaiting them, so ten callers reach here before the first
 * connect has resolved. Until 2026-09-16 each of them built its own MongoClient: `_db` was set only
 * AFTER `await connect()`, so every caller that arrived in that window passed the `if (_db)` check.
 * backend.log showed ten "Connected to MongoDB" lines in one second at every boot — nine clients
 * that nothing could ever close (`_client` kept only the last), each holding a pool and a topology
 * monitor against Atlas for the life of the process. The fix is the in-flight promise: the first
 * caller starts the connect, everyone else awaits the same one.
 */
export async function getDb() {
    if (_db) return _db
    if (!_connecting) {
        _connecting = _connect().finally(() => { _connecting = null })
    }
    return _connecting
}

async function _connect() {
    const uri = config.mongoUri
    if (!uri) throw new Error('MONGODB_URI is not set in environment variables')

    const client = _createClient(uri, {
        serverApi: {
            version: ServerApiVersion.v1,
            strict: true,
            deprecationErrors: true,
        },
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        family: 4, // force IPv4 — fixes TLS handshake failures on Render
    })

    await client.connect()
    // `db(undefined)` is the driver's own "use the name in the URI" — so an unset DB_NAME keeps the
    // historical behaviour EXACTLY, and the deployed environment does not have to be told anything.
    // Set locally, it is what stops a laptop and the deployed instance from being the same database
    // (and therefore contending for the one background-loops lease). See config.dbName.
    _client = client
    _db = client.db(config.dbName ?? undefined)

    logger.info(LOG, `Connected to MongoDB — db "${_db.databaseName}"`)
    return _db
}

/** Test seam — swap the MongoClient constructor. Returns a restore function; `null` restores the driver's. */
export function _setClientFactory(fn) {
    const prev = _createClient
    _createClient = fn ?? _defaultClientFactory
    return () => { _createClient = prev }
}

/**
 * The database this process is ACTUALLY using — not what an env var says it should be.
 *
 * The Aether engine is a separate Python process that has to reach the same database.
 * Having both sides read their own env var is what let one run write a full parallel copy
 * of every aether_* collection into `botmarket` while everything else read `test`: the
 * bridge in aetherScheduler mapped DB_NAME → MONGO_DB, DB_NAME was unset, so it mapped
 * nothing and both sides landed on a hardcoded default that happened to agree. Passing the
 * resolved name instead means the engine cannot disagree with us, whatever the env holds.
 *
 * Synchronous on purpose: by the time the scheduler starts, the loop lease has already
 * awaited getDb(), so `_db` is live. `config.dbName` is the fallback before we connect,
 * and null means "the driver will pick" — which the caller must then refuse to guess at.
 */
export function getDbName() {
    return _db?.databaseName ?? config.dbName ?? null
}

/**
 * The other half of the lazy singleton above. A connected MongoClient keeps a pool AND a topology
 * monitor that pings every replica-set member on a heartbeat — all of it `ref`'d, so the event loop
 * can never drain and the process can never exit on its own.
 *
 * The long-lived server doesn't care: it exits by signal. A TEST process does. Without this, one
 * test reaching any of getDb's ~48 caller modules meant `npm test` passed every assertion and then
 * hung forever — and three of those orphans sat on Atlas connections for three days before anyone
 * noticed, because a leaked handle looks exactly like a suite that is still running.
 *
 * Idempotent, and safe to call having never connected: both callers (the test teardown, and anyone
 * adding a server shutdown path later) should be able to call it blind.
 */
export async function closeDb() {
    // A connect still in flight will resolve to a client somebody has to close. Wait for it (a
    // failed connect is nothing to close), THEN take the handle — otherwise a teardown that races
    // an un-awaited ensure*Indexes() leaves exactly the orphan this function exists to prevent.
    if (_connecting) await _connecting.catch(() => {})
    const client = _client
    // Cleared BEFORE the await, so a getDb() racing this one builds a fresh client rather than
    // handing back the connection being torn down.
    _client = null
    _db = null
    if (!client) return
    await client.close()
    logger.info(LOG, 'Closed the MongoDB connection')
}

/** Return `doc` without its Mongo `_id` field. Passes through falsy values. */
export function stripId(doc) {
    if (!doc) return doc
    const { _id, ...rest } = doc
    return rest
}

/** Map stripId over an array of docs. */
export function stripIds(docs) {
    return docs.map(stripId)
}
