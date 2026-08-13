/**
 * Which workspace the user is standing in.
 *
 *   GET /api/workspace              → { workspace, stored }
 *   PUT /api/workspace { workspace} → { workspace, stored }
 *
 * Its own surface rather than a field on /api/paper/state: a workspace is not a paper concept, and
 * `manual` — the whole reason this exists — is the one workspace with no paper account behind it.
 */

import { Router }      from 'express'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { log }         from '../../middleware/logger.middleware.js'
import * as ctrl       from './workspace.controller.js'

export const workspaceRoutes = Router()
workspaceRoutes.use(requireAuth)

workspaceRoutes.get('/', log, ctrl.getWorkspace)
workspaceRoutes.put('/', log, ctrl.putWorkspace)
