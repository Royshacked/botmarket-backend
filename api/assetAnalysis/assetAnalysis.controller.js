import { llmUserIntentService } from '../../services/llmUserIntent.service.js'
import { logger } from '../../services/logger.service.js'
import { assetAnalysisService } from './assetAnalysis.service.js'


// export async function getAssetAnalysis(req, res) {
// 	try {
// 		const { symbol } = req.params
// 		const assetNews = await assetAnalysisService.getBySymbol(symbol)
// 		res.send(assetNews)
// 	} catch (err) {
// 		logger.error('Failed to get asset news', err)
// 		res.status(500).send({ err: 'Failed to get asset news' })
// 	}
// }

export async function getAssetAnalysis(req, res) {
	try {
		const { userPrompt } = req.body
		const userIntent = await llmUserIntentService.getUserIntent(userPrompt)
		console.log("userIntent",userIntent)
		const symbol = userIntent.ticker
		const assetNews = await assetAnalysisService.getAssetAnalysis(symbol)
		res.send(assetNews)
	} catch (err) {
		logger.error('Failed to get asset news', err)
		res.status(500).send({ err: 'Failed to get asset news' })
	}
}