import { getDb } from '../../providers/mongodb.provider.js'
import { COLLECTION, stripUser, buildUserDoc } from './user.model.js'
import { logger } from '../../services/logger.service.js'
import { seedBotConversation } from '../chat/chat.service.js'
import { getMonthlyUsage } from '../../services/tokenUsage.service.js'

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
    if (!user) {
        const err = new Error('User not found')
        err.status = 404
        throw err
    }
    return user.preferences ?? {}
}

async function savePreferences(id, preferences) {
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
        const err = new Error('preferences must be an object')
        err.status = 400
        throw err
    }
    const db = await getDb()
    const updated = await db.collection(COLLECTION).findOneAndUpdate(
        { id },
        { $set: { preferences, updatedAt: Date.now() } },
        { returnDocument: 'after', projection: { preferences: 1 } }
    )
    if (!updated) {
        const err = new Error('User not found')
        err.status = 404
        throw err
    }
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
    if (!user) {
        const err = new Error('User not found')
        err.status = 404
        throw err
    }
    return stripUser(user)
}

async function createUser({ username, fullname, password }) {
    const db = await getDb()

    const existing = await db.collection(COLLECTION).findOne({ username })
    if (existing) {
        const err = new Error('Username already exists')
        err.status = 409
        throw err
    }

    const doc = await buildUserDoc({ username, fullname, password })
    await db.collection(COLLECTION).insertOne(doc)
    logger.info(LOG, 'user created', { username })
    seedBotConversation(doc.id).catch(err => logger.warn(LOG, 'seedBotConversation failed', err.message))
    return stripUser(doc)
}

async function updateUser(id, { username, fullname }) {
    const db = await getDb()

    const set = { updatedAt: Date.now() }
    if (username !== undefined) set.username = username
    if (fullname !== undefined) set.fullname = fullname

    const updated = await db.collection(COLLECTION).findOneAndUpdate(
        { id },
        { $set: set },
        { returnDocument: 'after' }
    )
    if (!updated) {
        const err = new Error('User not found')
        err.status = 404
        throw err
    }

    logger.info(LOG, 'user updated', { id })
    return stripUser(updated)
}

async function deleteUser(id) {
    const db = await getDb()
    const result = await db.collection(COLLECTION).deleteOne({ id })
    if (result.deletedCount === 0) {
        const err = new Error('User not found')
        err.status = 404
        throw err
    }
    logger.info(LOG, 'user deleted', { id })
    return { message: 'User deleted' }
}
