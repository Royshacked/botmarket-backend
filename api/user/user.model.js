import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import { getDb } from '../../providers/mongodb.provider.js'

export const COLLECTION = 'users'

export async function buildUserDoc({ username, fullname, password }) {
    const passwordHash = await bcrypt.hash(password, 10)
    const now = Date.now()
    return {
        id: randomUUID(),
        username,
        fullname,
        passwordHash,
        preferences: {}, // account-level UI prefs (theme/accent/design/AI settings), synced from the client
        // Spend ceiling, USD/month. null = use config.tokenDegradeUsd. Past it, chat DEGRADES to
        // the cheap model — it is never refused. `exemptFromBudget` opts an account out entirely;
        // it exists instead of reading `isAdmin`, which auth.middleware force-sets to false on
        // every request by design. See tokenUsage.ceilingFor.
        budgetUsd: null,
        exemptFromBudget: false,
        createdAt: now,
        updatedAt: now,
    }
}

export async function ensureUserIndexes() {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true })
        await db.collection(COLLECTION).createIndex({ username: 1 }, { unique: true })
    } catch (err) {
        console.warn('[users] ensureUserIndexes failed:', err.message)
    }
}

/**
 * Every user id, as strings. The BROADCAST fan-out — the read a notifier makes when the thing it is
 * announcing has no owner to key on (the daily market brief, the strategy desk's house view).
 *
 * It lives here rather than in either notifier because both need the same mechanism and this module
 * owns the collection: the second copy would have been a second place that knows users are keyed by
 * `id` and not by `_id`, which is exactly the confusion the id scheme already invites.
 */
export async function listAllUserIds() {
    const db   = await getDb()
    const rows = await db.collection(COLLECTION).find({}, { projection: { id: 1 } }).toArray()
    return rows.map(r => r?.id).filter(Boolean).map(String)
}

export function stripUser(doc) {
    if (!doc) return doc
    const { _id, passwordHash, ...rest } = doc
    return rest
}
