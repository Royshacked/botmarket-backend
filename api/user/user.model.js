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

export function stripUser(doc) {
    if (!doc) return doc
    const { _id, passwordHash, ...rest } = doc
    return rest
}
