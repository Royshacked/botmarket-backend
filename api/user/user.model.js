import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import { getDb } from '../../providers/mongodb.provider.js'
import { logger } from '../../services/logger.service.js'

export const COLLECTION = 'users'

export const DEFAULT_ROLE = 'trader'

// What a new account must look like. The password rule is the SAME one the sign-up form enforces
// (AuthModal.validatePassword) — until 2026-09-16 it had no server twin, so a request that skipped
// the form could register any string, and a username had no bound at all.
export const USERNAME_MIN = 3
export const USERNAME_MAX = 32
export const FULLNAME_MAX = 80
export const PASSWORD_MIN = 8
export const PASSWORD_MIN_DIGITS = 2

/**
 * The reason a new account is refused, or null when it may be created. Pure. `fields` names which
 * of the three to check, so a rename validates the username alone.
 * @returns {string|null}
 */
export function invalidUserFields({ username, fullname, password } = {}, fields = ['username', 'fullname', 'password']) {
    if (fields.includes('username')) {
        if (typeof username !== 'string' || username.trim() !== username) return 'username must not start or end with whitespace'
        if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) return `username must be ${USERNAME_MIN}–${USERNAME_MAX} characters`
        if (/\s/.test(username)) return 'username must not contain whitespace'
    }
    if (fields.includes('fullname')) {
        if (typeof fullname !== 'string' || !fullname.trim()) return 'fullname is required'
        if (fullname.length > FULLNAME_MAX) return `fullname must be at most ${FULLNAME_MAX} characters`
    }
    if (fields.includes('password')) {
        if (typeof password !== 'string' || password.length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`
        if ((password.match(/\d/g) ?? []).length < PASSWORD_MIN_DIGITS) return `password must contain at least ${PASSWORD_MIN_DIGITS} numbers`
    }
    return null
}

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
        logger.warn('[users]', 'ensureUserIndexes failed:', err.message)
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

/** Is this one user an admin — the same `role ?? isAdmin` rule as listAdminUserIds, for one id. */
export async function isAdminUser(id) {
    if (!id) return false
    const db  = await getDb()
    const doc = await db.collection(COLLECTION).findOne({ id: String(id) }, { projection: { role: 1, isAdmin: 1, _id: 0 } })
    return !!doc && (doc.role === 'admin' || (doc.role == null && doc.isAdmin === true))
}

// The same answer, remembered for a few minutes. Since the house models (2026-09-21) every desk
// turn asks it — an admin runs their own pick, anyone else the house's — and a findOne per turn
// for a fact that changes when an account is promoted is a read the turn does not need. A
// promotion shows up within the TTL; the throw-through on a failed read is the caller's to catch,
// exactly as with the uncached one, and a failure is not remembered.
const ADMIN_TTL_MS = 5 * 60 * 1000
const _adminCache  = new Map() // id → { value, at }
export async function isAdminUserCached(id, _lookup = isAdminUser) {
    if (!id) return false
    const key = String(id)
    const hit = _adminCache.get(key)
    if (hit && Date.now() - hit.at < ADMIN_TTL_MS) return hit.value
    const value = await _lookup(key)
    _adminCache.set(key, { value, at: Date.now() })
    return value
}
export function _resetAdminCache() { _adminCache.clear() }

export function stripUser(doc) {
    if (!doc) return doc
    // pushSubscriptions carries the devices' encryption keys — it leaves only through /api/push.
    const { _id, passwordHash, pushSubscriptions, ...rest } = doc
    return rest
}
