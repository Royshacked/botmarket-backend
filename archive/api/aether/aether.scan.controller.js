// Archived 2026-11-09 with Argus's list-building chat (archive/README.md): the two Aether endpoints that served
// the radar cut. They were mounted in api/aether/aether.routes.js as GET /scan-universe and POST /batch-read.
import { getScanUniverse } from '../../services/aetherScanUniverse.service.js'
import { batchRead } from '../../services/aetherBatchRead.service.js'
import { makeHandle } from '../../../api/_shared/handle.util.js'
import { httpError } from '../../../services/httpError.util.js'

const handle = makeHandle('[aether:controller]')

/**
 * The names this user's next radar scan should carry to Argus.
 *
 * Any signed-in user, like the board it is built from — but the answer is PER USER, because the
 * exclusions are: "the names I already listed" is a fact about one person's scanning, where the
 * events and the reads are broadcast measurements. Two people working the same board get the same
 * events and different universes, which is correct.
 *
 * Read-only. Nothing is marked as handed over here — the exclusion keys on the LIST Argus saves,
 * so asking what the universe is costs nothing and changes nothing. Pressing the button twice
 * without saving a list gives the same names both times.
 */
export const getScanUniverseRead = handle('getScanUniverse', async (req, res) => {
    const days = Number(req.query?.days)
    res.json(await getScanUniverse(req.user._id,
        Number.isFinite(days) && days > 0 ? { days: Math.min(days, 90) } : {}))
})

/**
 * Prometheus over a whole list — the leg after Argus's cut.
 *
 * One model call PER NAME on this user's budget, so it is capped in the service and not here: the
 * cap is a fact about the batch, not about the route. Minutes for a long list, which is why the
 * client's timeout is its own number (see the remote service) rather than the default.
 *
 * Answers the judged rows whether or not every read landed. A name that could not be read comes
 * back flagged rather than missing, so the caller's list never silently shortens.
 */
export const postBatchRead = handle('postBatchRead', async (req, res) => {
    const { tickers } = req.body ?? {}
    if (!Array.isArray(tickers)) throw httpError(400, 'tickers must be an array')
    res.json(await batchRead({ tickers, userId: req.user?._id }))
})
