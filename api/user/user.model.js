import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import { getDb } from '../../providers/mongodb.provider.js'

export const COLLECTION = 'users'

export const ROLES = ['admin', 'trader']
export const DEFAULT_ROLE = 'trader'

export async function buildUserDoc({ username, fullname, password }) {
    const passwordHash = await bcrypt.hash(password, 10)
    const now = Date.now()
    return {
        id: randomUUID(),
        username,
        fullname,
        passwordHash,
        role: DEFAULT_ROLE,
        preferences: {},
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

/**
 * Every ADMIN user id. The narrowed fan-out, for a feed traders cannot see at all: the strategy
 * desk's conversation is dropped client-side for non-admins (`ADMIN_BOT_IDS`), so a card posted to
 * a trader is a row nobody will ever read.
 *
 * The `role ?? isAdmin` fallback is not a second rule — it is the SAME one the token is minted from
 * (authentication.service), kept in step because a legacy doc predating `role` must not silently
 * drop out of a feed its owner can still sign in and see.
 */
export async function listAdminUserIds() {
    const db   = await getDb()
    const rows = await db.collection(COLLECTION)
        // `{ role: null }` matches missing AND explicitly null — the exact reach of the `??` the
        // token uses, which `$exists: false` would have narrowed by one case.
        .find({ $or: [{ role: 'admin' }, { role: null, isAdmin: true }] }, { projection: { id: 1 } })
        .toArray()
    return rows.map(r => r?.id).filter(Boolean).map(String)
}

export function stripUser(doc) {
    if (!doc) return doc
    const { _id, passwordHash, ...rest } = doc
    return rest
}
