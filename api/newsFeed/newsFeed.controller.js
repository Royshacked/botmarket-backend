import { logger } from '../../services/logger.service.js'
import { newsFeedService } from './newsFeed.service.js'

export async function getNewsFeeds(req, res) {
	try {
		const newsFeeds = await newsFeedService.query()
		res.send(newsFeeds)
	} catch (err) {
		logger.error('Failed to get newsFeeds', err)
		res.status(500).send({ err: 'Failed to get newsFeeds' })
	}
}

