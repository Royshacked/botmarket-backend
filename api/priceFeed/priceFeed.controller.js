import { logger } from "../../services/logger.service.js"
import { priceFeedService } from "./priceFeed.service.js"


export async function getPriceFeed(req, res) {
    const { ticker } = req.params
    const options = {
        timeSpan: req.query.timeSpan,
        multiplier: req.query.multiplier,
        from: req.query.from || Date.now() - 14 * 24 * 60 * 60 * 1000,
        to: req.query.to || Date.now(),
    }
    try {
        const priceFeed = await priceFeedService.query(ticker, options)
        res.send(priceFeed)
    } catch (err) {
        logger.error('Failed to get priceFeed', err)
        res.status(500).send({ err: 'Failed to get priceFeed' })
    }
}