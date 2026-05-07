import { llmUserIntentService } from '../../services/llmUserIntent.service.js'
import { logger } from '../../services/logger.service.js'
import { analysisService } from './analysis.service.js'
import { responseComposerService } from '../../services/responseComposer.service.js'


export async function getAnalysis(req, res) {
	try {
		const { userPrompt } = req.body
		const userIntent = await llmUserIntentService.getUserIntent(userPrompt)
		const ticker = userIntent.ticker
		const analysisType = userIntent.analysisType
        let newsAnalysis = null
        let technicalAnalysis = null
		if (analysisType.includes('news')) {
			newsAnalysis = await analysisService.getNewsAnalysis(ticker)            
        }
		if (analysisType.includes('technical')) {
			technicalAnalysis = await analysisService.getTechnicalAnalysis(ticker)
		}
        // const analysis = await responseComposerService.composeResponse(newsAnalysis, technicalAnalysis)
        // if (!analysis) {
        //     return res.status(400).send({ err: 'No analysis provided' })
        // }
		res.send(newsAnalysis)
	} catch (err) {
		logger.error('Failed to get asset news', err)
		res.status(500).send({ err: 'Failed to get asset news' })
	}
}