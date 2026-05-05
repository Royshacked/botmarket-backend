import { llmAnalysisService } from "../../services/llmAnalysis.service.js"
import { newsService } from "../news/news.service.js"


export const assetAnalysisService = {
    getAssetAnalysis,
}

async function getAssetAnalysis(symbol) {
    const all = await newsService.getNewsBySymbol(symbol)
    console.log("all:",all.articles.length)
    let sorted = all
    sorted = sorted.articles.sort((a, b) => b.datetime - a.datetime)
    const latest = sorted.slice(0, 10)
    const forLLM = latest.map(article => ({
        datetime: article.datetime,
        headline: article.headline,
        related: article.related,
        source: article.source,
        summary: article.summary,
        url: article.url,
    }))

    const assetAnalysisLLM = await llmAnalysisService.getLLMNewsAnalysis(forLLM,symbol)
    return Promise.resolve(assetAnalysisLLM)
}



