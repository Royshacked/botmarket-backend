import { fetchAssetNews } from "../../providers/finnhub.provider.js"
import { llmAnalysisService } from "../../services/llmAnalysis.service.js"
import { isCacheFresh, loadFromFile, saveToFile } from "../../services/util.service.js"


export const assetAnalysisService = {
    getBySymbol,
}

async function getBySymbol(symbol) {
    const all = await _getAllBySymbol(symbol)
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

    const assetAnalysisLLM = await llmAnalysisService.getAssetAnalysis(forLLM,symbol)
    return assetAnalysisLLM
}

async function _getAllBySymbol(symbol) {
    const key = symbol.toUpperCase()
    const all = await loadFromFile("assetNews")
    const entry = all[key]
    if (isCacheFresh(entry, 5 * 60 * 1000)) return entry
    console.log("getAllBySymbol",symbol)
    const articles = await fetchAssetNews(symbol)
    const updated = { ...all, [key]: { lastFetchedAt: Date.now(), articles } }
    await saveToFile("assetNews", updated)
    return updated[key]
}


