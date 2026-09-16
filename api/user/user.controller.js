import { userService } from './user.service.js'
import { makeHandle }  from '../_shared/handle.util.js'
import { httpError }   from '../../services/httpError.util.js'

const LOG    = '[user:controller]'
const handle = makeHandle(LOG)

export const list = handle('list', async (req, res) => {
    const { search, page, limit } = req.query
    res.json(await userService.listUsers({ search, page, limit }))
})

export const getOne = handle('getOne', async (req, res) => {
    res.json(await userService.getUserById(req.params.id))
})

export const create = handle('create', async (req, res) => {
    res.status(201).json(await userService.createUser(req.body ?? {}))
})

export const update = handle('update', async (req, res) => {
    res.json(await userService.updateUser(req.params.id, req.body ?? {}))
})

export const remove = handle('remove', async (req, res) => {
    res.json(await userService.deleteUser(req.params.id))
})

/**
 * The per-user reads a trader may make about THEMSELVES — usage and preferences — and an admin
 * about anyone. The admin check reads `role`, which is what the token carries
 * (authentication.service mints `{ _id, username, fullname, role }`). It used to read
 * `req.user.isAdmin`, a field no token has ever had, so the admin branch never fired.
 */
export function assertOwnOrAdmin(req) {
    if (req.params.id !== req.user?._id && req.user?.role !== 'admin') throw httpError(403, 'Forbidden')
}

export const getTokenUsage = handle('getTokenUsage', async (req, res) => {
    assertOwnOrAdmin(req)
    res.json(await userService.getTokenUsage(req.params.id, req.query.month))
})

export const getPreferences = handle('getPreferences', async (req, res) => {
    assertOwnOrAdmin(req)
    res.json(await userService.getPreferences(req.params.id))
})

export const updatePreferences = handle('updatePreferences', async (req, res) => {
    assertOwnOrAdmin(req)
    res.json(await userService.savePreferences(req.params.id, req.body ?? {}))
})
