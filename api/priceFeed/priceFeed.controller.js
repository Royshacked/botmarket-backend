import { logger } from "../../services/logger.service.js"
import { priceFeedService } from "./priceFeed.service.js"


export async function getPriceFeed(req, res) {
    const { ticker } = req.params
    try {
        const priceFeed = await priceFeedService.query(ticker)
        res.send(priceFeed)
    } catch (err) {
        logger.error('Failed to get priceFeed', err)
        res.status(500).send({ err: 'Failed to get priceFeed' })
    }
}