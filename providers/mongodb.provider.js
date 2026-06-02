import { MongoClient, ServerApiVersion } from 'mongodb'
import { logger } from '../services/logger.service.js'

const LOG = '[mongodb]'
const URI = process.env.MONGODB_URI

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
    _db = _client.db()

    logger.info(LOG, 'Connected to MongoDB')
    return _db
}
