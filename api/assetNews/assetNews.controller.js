import { logger } from '../../services/logger.service.js'
import { assetNewsService } from './assetNews.service.js'


export async function getAssetNews(req, res) {
	try {
		const { symbol } = req.params
		const assetNews = await assetNewsService.getBySymbol(symbol)
		res.send(assetNews)
	} catch (err) {
		logger.error('Failed to get asset news', err)
		res.status(500).send({ err: 'Failed to get asset news' })
	}
}