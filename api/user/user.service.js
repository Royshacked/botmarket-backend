import { getDb } from '../../providers/mongodb.provider.js'
import { COLLECTION, stripUser, buildUserDoc, invalidUserFields } from './user.model.js'
import { logger } from '../../services/logger.service.js'
import { seedBotConversation } from '../chat/chat.service.js'
import { getMonthlyUsage } from '../../services/tokenUsage.service.js'
import { httpError } from '../../services/httpError.util.js'

const LOG = '[userService]'

export const userService = {
    listUsers,
    getUserById,
    createUser,
    updateUser,
    deleteUser,
    getTokenUsage,
    getPreferences,
    savePreferences,
}

// Account-level UI preferences (theme/accent/design/AI settings). The client owns the
// full snapshot (localStorage is the live copy) and pushes it whole; we store it as an
// opaque object so new preference keys need no backend change.
async function getPreferences(id) {
    const db = await getDb()
    const user = await db.collection(COLLECTION).findOne({ id }, { projection: { preferences: 1 } })
    if (!user) throw httpError(404, 'User not found')
    return user.preferences ?? {}
}

async function savePreferences(id, preferences) {
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
        throw httpError(400, 'preferences must be an object')
    }
    const db = await getDb()
    const updated = await db.collection(COLLECTION).findOneAndUpdate(
        { id },
        { $set: { preferences, updatedAt: Date.now() } },
        { returnDocument: 'after', projection: { preferences: 1 } }
    )
    if (!updated) throw httpError(404, 'User not found')
    return updated.preferences ?? {}
}

async function getTokenUsage(userId, month) {
    return getMonthlyUsage(userId, month)
}

async function listUsers({ search, page = 1, limit = 20 } = {}) {
    const db = await getDb()

    const filter = {}
    if (search) {
        const re = { $regex: search, $options: 'i' }
        filter.$or = [{ username: re }, { fullname: re }]
    }

    const pageNum  = Math.max(1, parseInt(page)  || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20))
    const skip     = (pageNum - 1) * limitNum

    const [docs, total] = await Promise.all([
        db.collection(COLLECTION).find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).toArray(),
        db.collection(COLLECTION).countDocuments(filter),
    ])

    return { users: docs.map(stripUser), total, page: pageNum, limit: limitNum }
}

async function getUserById(id) {
    const db = await getDb()
    const user = await db.collection(COLLECTION).findOne({ id })
    if (!user) throw httpError(404, 'User not found')
    return stripUser(user)
}

/**
 * THE way an account comes to exist — self sign-up (authentication.service) and the admin's
 * POST /api/users both land here. It used to be written twice, and the copies had drifted: only
 * this one seeded Axl's welcome conversation, and this one had no live caller, so no real user
 * had ever been welcomed.
 */
async function createUser({ username, fullname, password }) {
    const invalid = invalidUserFields({ username, fullname, password })
    if (invalid) throw httpError(400, invalid)

    const db = await getDb()
    const existing = await db.collection(COLLECTION).findOne({ username })
    if (existing) throw httpError(409, 'Username already exists')

    const doc = await buildUserDoc({ username, fullname, password })
    await db.collection(COLLECTION).insertOne(doc)
    logger.info(LOG, 'user created', { username })
    // Awaited, not fire-and-forget: the welcome must have landed before this returns, so a caller
    // that exits right after (scripts/create-admin-user) does not cut the seed's writes off, and
    // there is ONE seeding call rather than two racing a non-atomic getOrCreateConversation. A seed
    // failure is still swallowed — it must not fail account creation.
    await seedBotConversation(doc.id).catch(err => logger.warn(LOG, 'seedBotConversation failed', err.message))
    return stripUser(doc)
}

async function updateUser(id, { username, fullname }) {
    const invalid = invalidUserFields({ username, fullname }, [
        ...(username !== undefined ? ['username'] : []),
        ...(fullname !== undefined ? ['fullname'] : []),
    ])
    if (invalid) throw httpError(400, invalid)

    const db = await getDb()

    const set = { updatedAt: Date.now() }
    if (username !== undefined) set.username = username
    if (fullname !== undefined) set.fullname = fullname

    const updated = await db.collection(COLLECTION).findOneAndUpdate(
        { id },
        { $set: set },
        { returnDocument: 'after' }
    ).catch(err => {
        // The unique index on `username` is the check; its refusal is the same 409 create answers,
        // not a 500 carrying the index name.
        if (err?.code === 11000) throw httpError(409, 'Username already exists')
        throw err
    })
    if (!updated) throw httpError(404, 'User not found')

    logger.info(LOG, 'user updated', { id })
    return stripUser(updated)
}

async function deleteUser(id) {
    const db = await getDb()
    const result = await db.collection(COLLECTION).deleteOne({ id })
    if (result.deletedCount === 0) throw httpError(404, 'User not found')
    logger.info(LOG, 'user deleted', { id })
    return { message: 'User deleted' }
}
