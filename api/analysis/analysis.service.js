import { llmNewsAnalysisService } from "../../services/llmNewsAnalysis.service.js"
import { llmPriceAnalysisService } from "../../services/llmPriceAnalysis.service.js"
import { newsService } from "../../services/news.service.js"
import { priceService } from "../../services/price.service.js"


export const analysisService = {
    getNewsAnalysis,
    getTechnicalAnalysis,
}

async function getNewsAnalysis(ticker, analysisGoal) {
    const all = await newsService.getNewsByTicker(ticker)
    const latest = newsService.getLatestNews(all, 10)
    const newData = latest.map(article => ({
        datetime: article.datetime,
        headline: article.headline,
        related: article.related,
        source: article.source,
        summary: article.summary,
        url: article.url,
    }))

    const newsAnalysisLLM = await llmNewsAnalysisService.getLLMNewsAnalysis(ticker, newData,analysisGoal)
    return Promise.resolve(newsAnalysisLLM)
}

async function getTechnicalAnalysis(ticker, analysisGoal) {
    const options = {timeSpan: 'day', multiplier: 1, from: Date.now() - 1000 * 60 * 60 * 24 * 30}
    const priceData = await priceService.getPriceData(ticker, options)
    console.log("i am in technical analysis service")
    const priceAnalysisLLM = await llmPriceAnalysisService.getLLMPriceAnalysis(ticker, priceData, analysisGoal)
    return Promise.resolve(priceAnalysisLLM)
}