import { MongoClient, ServerApiVersion } from 'mongodb'
import { logger } from '../services/logger.service.js'
import { config } from '../services/config.js'

const LOG = '[mongodb]'
const URI = config.mongoUri

let _client = null
let _db = null

export async function getDb() {
    if (_db) return _db

    if (!URI) throw new Error('MONGODB_URI is not set in environment variables')

    _client = new MongoClient(URI, {
        serverApi: {
            version: ServerApiVersion.v1,
            strict: true,
            deprecationErrors: true,
        },
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        family: 4, // force IPv4 — fixes TLS handshake failures on Render
    })

    await _client.connect()
    // `db(undefined)` is the driver's own "use the name in the URI" — so an unset DB_NAME keeps the
    // historical behaviour EXACTLY, and the deployed environment does not have to be told anything.
    // Set locally, it is what stops a laptop and the deployed instance from being the same database
    // (and therefore contending for the one background-loops lease). See config.dbName.
    _db = _client.db(config.dbName ?? undefined)

    logger.info(LOG, `Connected to MongoDB — db "${_db.databaseName}"`)
    return _db
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
