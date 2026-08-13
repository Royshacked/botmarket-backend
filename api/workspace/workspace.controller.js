/**
 * The workspace the user is standing in — read and write.
 *
 * Two endpoints and nothing else. The GET returns the RESOLVED workspace (paper flag joined with
 * the stored choice), because that is the question every caller actually has; the PUT records a
 * choice the user made. See api/workspace/workspace.model.js for the rule and why it is persisted.
 */

import { brokerService } from '../broker/broker.service.js'
import { getStoredWorkspace, setStoredWorkspace } from '../../services/workspace.service.js'
import { resolveWorkspace, isValidWorkspace, WORKSPACES } from './workspace.model.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[workspace:controller]'

/** GET /api/workspace → { workspace, stored } */
export async function getWorkspace(req, res) {
    try {
        const userId = req.user._id
        const [connections, stored] = await Promise.all([
            brokerService.listConnections(userId).catch(() => ({})),
            getStoredWorkspace(userId),
        ])
        res.json({ workspace: resolveWorkspace(!!connections?.paper, stored), stored })
    } catch (err) {
        logger.error(LOG, 'getWorkspace failed', err.message)
        res.status(500).json({ error: 'could not read workspace' })
    }
}

/**
 * PUT /api/workspace { workspace } → { workspace, stored }
 *
 * The stored value is only half the answer, so the response reports the RESOLVED one too: a client
 * that PUTs 'manual' while the paper flag is still on would otherwise believe it landed in manual
 * while every server-side read says paper. Turning the paper flag off is a separate call the client
 * already makes (PUT /api/paper/mode) — this endpoint deliberately does not reach into it, because a
 * write that silently flips another subsystem's toggle is the kind of hidden coupling that makes the
 * two disagree later.
 */
export async function putWorkspace(req, res) {
    const workspace = req.body?.workspace
    if (!isValidWorkspace(workspace)) {
        return res.status(400).json({ error: `workspace must be one of: ${WORKSPACES.join(', ')}` })
    }
    try {
        const userId = req.user._id
        const result = await setStoredWorkspace(userId, workspace)
        if (!result.ok) return res.status(500).json({ error: result.reason })

        const connections = await brokerService.listConnections(userId).catch(() => ({}))
        res.json({ workspace: resolveWorkspace(!!connections?.paper, result.workspace), stored: result.workspace })
    } catch (err) {
        logger.error(LOG, 'putWorkspace failed', err.message)
        res.status(500).json({ error: 'could not save workspace' })
    }
}
