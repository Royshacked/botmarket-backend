import { authService } from './authentication.service.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[authController]'
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export async function signup(req, res, next) {
    try {
        const { username, fullname, password } = req.body ?? {}
        if (!username || !fullname || !password) {
            return res.status(400).json({ error: 'username, fullname and password are required' })
        }
        const user = await authService.signup(username, fullname, password)
        res.status(201).json({ message: 'User created', user })
    } catch (err) {
        next(err)
    }
}

export async function signin(req, res, next) {
    try {
        const { username, password } = req.body ?? {}
        if (!username || !password) {
            return res.status(400).json({ error: 'username and password are required' })
        }
        const { token, user } = await authService.signin(username, password)
        res.cookie('token', token, {
            httpOnly: true,
            sameSite: 'strict',
            secure: false,
            maxAge: SEVEN_DAYS_MS,
        })
        res.json({ username: user.username, fullname: user.fullname })
    } catch (err) {
        next(err)
    }
}

export async function signout(req, res) {
    res.clearCookie('token')
    res.json({ message: 'Signed out successfully' })
}

export async function me(req, res) {
    res.json(req.user)
}
