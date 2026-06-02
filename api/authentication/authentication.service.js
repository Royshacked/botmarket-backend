import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { getDb } from '../../providers/mongodb.provider.js'
import { COLLECTION, stripUser } from '../user/user.model.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[authService]'

export const authService = {
    signup,
    signin,
    signout,
}

async function signup(username, fullname, password) {
    const db = await getDb()

    const existing = await db.collection(COLLECTION).findOne({ username })
    if (existing) {
        const err = new Error('Username already exists')
        err.status = 409
        throw err
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const now = Date.now()
    const doc = {
        id: String(now),
        username,
        fullname,
        passwordHash,
        createdAt: now,
        updatedAt: now,
    }

    await db.collection(COLLECTION).insertOne(doc)
    logger.info(LOG, 'user signed up', { username })
    return stripUser(doc)
}

async function signin(username, password) {
    const db = await getDb()

    const user = await db.collection(COLLECTION).findOne({ username })
    if (!user) {
        const err = new Error('Invalid credentials')
        err.status = 401
        throw err
    }

    const match = await bcrypt.compare(password, user.passwordHash)
    if (!match) {
        const err = new Error('Invalid credentials')
        err.status = 401
        throw err
    }

    const payload = { _id: user.id, username: user.username, fullname: user.fullname, isAdmin: user.isAdmin ?? false }
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' })

    logger.info(LOG, 'user signed in', { username })
    return { token, user: { username: user.username, fullname: user.fullname } }
}

function signout() {
    return { message: 'Signed out successfully' }
}
