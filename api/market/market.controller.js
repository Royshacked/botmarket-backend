import { getMarketStatus } from '../../services/market.service.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[market:controller]'

export async function getStatus(req, res) {
    try {
        const symbol     = req.query.symbol ?? ''
        const assetClass = req.query.assetClass ?? req.query.asset_class ?? undefined
        res.send(getMarketStatus(symbol, assetClass))
    } catch (err) {
        logger.error(LOG, 'getStatus failed', err)
        res.status(500).send({ error: 'Failed to get market status' })
    }
}
