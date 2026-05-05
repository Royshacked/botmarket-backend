import { logger } from '../../services/logger.service.js'
import { newsService } from './news.service.js'

export async function getNewsFeeds(req, res) {
	try {
		const newsFeeds = await newsService.query()
		res.send(newsFeeds)
	} catch (err) {
		logger.error('Failed to get newsFeeds', err)
		res.status(500).send({ err: 'Failed to get newsFeeds' })
	}
}

