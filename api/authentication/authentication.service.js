import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getDb } from '../../providers/mongodb.provider.js'
import { COLLECTION } from '../user/user.model.js'
import { userService } from '../user/user.service.js'
import { logger } from '../../services/logger.service.js'
import { config } from '../../services/config.js'
import { httpError } from '../../services/httpError.util.js'

const LOG = '[authService]'

export const authService = {
    signup,
    signin,
}

/**
 * Self sign-up IS account creation — the one path in user.service, which validates the fields,
 * refuses a taken name and seeds Axl's welcome. This module used to carry its own copy of the
 * insert, minus the welcome, so the only users who were ever welcomed were the ones an admin
 * created by hand — and nothing in the client did that.
 */
async function signup(username, fullname, password) {
    const user = await userService.createUser({ username, fullname, password })
    logger.info(LOG, 'user signed up', { username })
    return user
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
