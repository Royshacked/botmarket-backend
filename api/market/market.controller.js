import { getMarketStatus } from '../../services/market.service.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[market:controller]'

export async function getStatus(req, res) {
    try {
        const symbol = req.query.symbol ?? ''
        res.send(getMarketStatus(symbol))
    } catch (err) {
        logger.error(LOG, 'getStatus failed', err)
        res.status(500).send({ error: 'Failed to get market status' })
    }
}
