import { userService } from './user.service.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[userController]'

export async function list(req, res, next) {
    try {
        const { search, page, limit } = req.query
        const result = await userService.listUsers({ search, page, limit })
        res.json(result)
    } catch (err) {
        next(err)
    }
}

export async function getOne(req, res, next) {
    try {
        const user = await userService.getUserById(req.params.id)
        res.json(user)
    } catch (err) {
        next(err)
    }
}

export async function create(req, res, next) {
    try {
        const user = await userService.createUser(req.body ?? {})
        res.status(201).json(user)
    } catch (err) {
        next(err)
    }
}

export async function update(req, res, next) {
    try {
        const user = await userService.updateUser(req.params.id, req.body ?? {})
        res.json(user)
    } catch (err) {
        next(err)
    }
}

export async function remove(req, res, next) {
    try {
        const result = await userService.deleteUser(req.params.id)
        res.json(result)
    } catch (err) {
        next(err)
    }
}

export async function getTokenUsage(req, res, next) {
    try {
        const { month } = req.query
        const usage = await userService.getTokenUsage(req.params.id, month)
        res.json(usage)
    } catch (err) {
        next(err)
    }
}

// Own-preferences only (admins may read/write any) — prefs are personal UI state.
function assertOwnPrefs(req) {
    if (req.params.id !== req.user?._id && !req.user?.isAdmin) {
        const err = new Error('Forbidden')
        err.status = 403
        throw err
    }
}

export async function getPreferences(req, res, next) {
    try {
        assertOwnPrefs(req)
        const prefs = await userService.getPreferences(req.params.id)
        res.json(prefs)
    } catch (err) {
        next(err)
    }
}

export async function updatePreferences(req, res, next) {
    try {
        assertOwnPrefs(req)
        const prefs = await userService.savePreferences(req.params.id, req.body ?? {})
        res.json(prefs)
    } catch (err) {
        next(err)
    }
}
