import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getDb } from '../../providers/mongodb.provider.js'
import { COLLECTION, stripUser, buildUserDoc } from '../user/user.model.js'
import { logger } from '../../services/logger.service.js'
import { config } from '../../services/config.js'
import { httpError } from '../../services/httpError.util.js'

const LOG = '[authService]'

export const authService = {
    signup,
    signin,
}

async function signup(username, fullname, password) {
    const db = await getDb()

    const existing = await db.collection(COLLECTION).findOne({ username })
    if (existing) throw httpError(409, 'Username already exists')

    const doc = await buildUserDoc({ username, fullname, password })
    await db.collection(COLLECTION).insertOne(doc)
    logger.info(LOG, 'user signed up', { username })
    return stripUser(doc)
}

async function signin(username, password) {
    const db = await getDb()

    // One sentence for both misses, so the answer never says which half was wrong.
    const user = await db.collection(COLLECTION).findOne({ username })
    if (!user) throw httpError(401, 'Invalid credentials')

    const match = await bcrypt.compare(password, user.passwordHash)
    if (!match) throw httpError(401, 'Invalid credentials')

    const role    = user.role ?? (user.isAdmin ? 'admin' : 'trader')
    const payload = { _id: user.id, username: user.username, fullname: user.fullname, role }
    const token = jwt.sign(payload, config.jwtSecret, { expiresIn: '7d' })

    logger.info(LOG, 'user signed in', { username })
    // Return the same shape as /api/auth/me (the decoded token) so the client has
    // a complete user — _id drives the chat WS and every authenticated call.
    return { token, user: payload }
}
