import { llmAnalysisService } from "../../services/llmAnalysis.service.js"
import { newsService } from "../../services/news.service.js"


export const analysisService = {
    getNewsAnalysis,
    getTechnicalAnalysis,
}

async function getNewsAnalysis(ticker) {
    const all = await newsService.getNewsByTicker(ticker)
    const latest = newsService.getLatestNews(all, 10)
    const forLLM = latest.map(article => ({
        datetime: article.datetime,
        headline: article.headline,
        related: article.related,
        source: article.source,
        summary: article.summary,
        url: article.url,
    }))

    const newsAnalysisLLM = await llmAnalysisService.getLLMNewsAnalysis(forLLM,ticker)
    return Promise.resolve(newsAnalysisLLM)
}

async function getTechnicalAnalysis(ticker) {
}