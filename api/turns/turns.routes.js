import express from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { stopTurn }    from '../_shared/turnRegistry.js'
import { logger }      from '../../services/logger.service.js'

/**
 * Stopping an agent turn.
 *
 * Its own endpoint because STOP and WALKING AWAY are different intentions and used to arrive as the
 * same signal — a closed socket. That cost the user any turn they navigated away from. Now leaving is
 * silent and stopping is spoken, so a turn can outlive the tab that started it.
 */
const router = express.Router()
router.use(requireAuth)

router.post('/:turnId/stop', log, (req, res) => {
    const stopped = stopTurn(req.params.turnId, req.user._id)
    // A miss is not an error: the turn may have finished between the click and the request, which is
    // the same outcome the user wanted.
    if (!stopped) logger.info('[turns]', `stop for ${req.params.turnId} matched nothing (already done?)`)
    res.json({ ok: true, stopped })
})

export const turnsRoutes = router
