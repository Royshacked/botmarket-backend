import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getDb } from '../../providers/mongodb.provider.js'
import { COLLECTION, stripUser, buildUserDoc } from '../user/user.model.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[authService]'

export const authService = {
    signup,
    signin,
}

async function signup(username, fullname, password) {
    const db = await getDb()

    const existing = await db.collection(COLLECTION).findOne({ username })
    if (existing) {
        const err = new Error('Username already exists')
        err.status = 409
        throw err
    }

    const doc = await buildUserDoc({ username, fullname, password })
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
    // Return the same shape as /api/auth/me (the decoded token) so the client has
    // a complete user — _id drives the chat WS and every authenticated call.
    return { token, user: payload }
}
