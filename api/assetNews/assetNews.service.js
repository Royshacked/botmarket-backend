import { fetchAssetNews } from "../../providers/finnhub.provider.js"
import { isCacheFresh, loadFromFile, saveToFile } from "../../services/util.service.js"


export const assetNewsService = {
    getBySymbol,
}

async function getBySymbol(symbol) {
    const key = symbol.toUpperCase()
    const all = loadFromFile("assetNews")
    const entry = all[key]
    if (isCacheFresh(entry)) return entry

    const articles = await fetchAssetNews(symbol)
    const updated = { ...all, [key]: { lastFetchedAt: Date.now(), articles } }
    saveToFile("assetNews", updated)
    return updated[key]
}


