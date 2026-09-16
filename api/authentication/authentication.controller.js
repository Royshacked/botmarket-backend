import { authService } from './authentication.service.js'
import { config }      from '../../services/config.js'
import { makeHandle }  from '../_shared/handle.util.js'
import { httpError }   from '../../services/httpError.util.js'

const LOG    = '[auth:controller]'
const handle = makeHandle(LOG)

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export const signup = handle('signup', async (req, res) => {
    const { username, fullname, password } = req.body ?? {}
    if (!username || !fullname || !password) throw httpError(400, 'username, fullname and password are required')
    const user = await authService.signup(username, fullname, password)
    res.status(201).json({ message: 'User created', user })
})

export const signin = handle('signin', async (req, res) => {
    const { username, password } = req.body ?? {}
    if (!username || !password) throw httpError(400, 'username and password are required')
    const { token, user } = await authService.signin(username, password)
    res.cookie('token', token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.isProduction,
        maxAge: SEVEN_DAYS_MS,
    })
    res.json(user)
})

export function signout(req, res) {
    res.clearCookie('token')
    res.json({ message: 'Signed out successfully' })
}

export function me(req, res) {
    res.json(req.user)
}
