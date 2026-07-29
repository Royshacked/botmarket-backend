import { logger }       from '../../services/logger.service.js'
import { setupService } from './setups.service.js'

const LOG = '[setups:controller]'

// Gate reasons that mean "the draft isn't finished" (a 400 the user can fix in chat) vs a real
// server failure. Keeps a missing stop zone from being reported as a 500.
const CLIENT_REASONS = new Set([
    'invalid_setup', 'invalid_zone', 'no_venue', 'not_found', 'in_position',
    'invalid_status', 'nothing_to_patch', 'closed_is_terminal',
])
// Reaching someone else's setup is its own answer — 403, not a 400 or a 500. The shared crud
// reports it apart from not_found, which the hand-rolled setup queries could not.
const _status = (reason) =>
    reason === 'forbidden' ? 403
        : (CLIENT_REASONS.has(reason) || reason?.startsWith('missing_') || reason?.startsWith('cannot_arm_')) ? 400
            : 500

/** Generate: persist a drafted setup (or update one in place when `updateId` is present). */
export async function generateSetup(req, res) {
    try {
        const { setup, accounts, mainAccountId, updateId, chat_state } = req.body ?? {}
        if (!setup || typeof setup !== 'object' || Array.isArray(setup)) {
            return res.status(400).send({ error: 'setup must be an object' })
        }

        const result = await setupService.generateSetup(setup, {
            userId:   req.user._id,
            accounts: Array.isArray(accounts) ? accounts : [],
            mainAccountId,
            updateId: updateId ?? null,
            chatState: chat_state,
        })
        if (!result.ok) return res.status(_status(result.reason)).send({ error: result.reason })

        res.send(result.setup)
    } catch (err) {
        logger.error(LOG, 'Failed to generate setup', err)
        res.status(500).send({ error: 'generate_failed' })
    }
}

export async function listSetups(req, res) {
    try {
        res.send(await setupService.listSetups(req.user._id, { status: req.query?.status ?? null }))
    } catch (err) {
        logger.error(LOG, 'Failed to list setups', err)
        res.status(500).send({ error: 'list_failed' })
    }
}

export async function getSetup(req, res) {
    try {
        const setup = await setupService.getSetup(req.params.id, req.user._id)
        if (!setup) return res.status(404).send({ error: 'not_found' })
        res.send(setup)
    } catch (err) {
        logger.error(LOG, 'Failed to get setup', err)
        res.status(500).send({ error: 'get_failed' })
    }
}

/** Status transitions (arm / disarm) and chat-state saves. Plan rewrites go through generate. */
export async function patchSetup(req, res) {
    try {
        const result = await setupService.patchSetup(req.params.id, req.body ?? {}, req.user._id)
        if (!result.ok) return res.status(_status(result.reason)).send({ error: result.reason })
        res.send(result.setup)
    } catch (err) {
        logger.error(LOG, 'Failed to patch setup', err)
        res.status(500).send({ error: 'patch_failed' })
    }
}

export async function deleteSetup(req, res) {
    try {
        const result = await setupService.deleteSetup(req.params.id, req.user._id)
        if (!result.ok) return res.status(_status(result.reason)).send({ error: result.reason })
        res.send({ ok: true })
    } catch (err) {
        logger.error(LOG, 'Failed to delete setup', err)
        res.status(500).send({ error: 'delete_failed' })
    }
}
