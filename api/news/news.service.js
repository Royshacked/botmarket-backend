import dotenv from 'dotenv'
dotenv.config()


import { deduplicateNewsFeed, filterTodaysNewsFeed, isCacheFresh, loadFromFile, saveToFile } from '../../services/util.service.js'
import { llmService } from '../../services/llmFilter.service.js'
import { fetchAssetNews, fetchNews } from '../../providers/finnhub.provider.js'

export const newsService = {
    query,
    getNewsBySymbol
}

const POLL_INTERVAL = 1000 * 10
let gIntervalId

// _getNewsFeed()
// _updateNewsFeed()

async function query() {
    const relevantNews = await loadFromFile("relevantNews")
    return Promise.resolve(relevantNews)
}


async function getNewsBySymbol(symbol) {
    const key = symbol.toUpperCase()
    const all = await loadFromFile("assetNews")
    const entry = all[key]
    if (isCacheFresh(entry, 60 * 60 * 1000)) return entry
    console.log("getAllBySymbol",symbol)
    const articles = await fetchAssetNews(symbol)
    const updated = { ...all, [key]: { lastFetchedAt: Date.now(), articles } }
    await saveToFile("assetNews", updated)
    return updated[key]
}


async function _getNewsFeed() {
    const newsFeed = await loadFromFile("newsFeed")
    if(newsFeed.length > 0) return newsFeed
    const news = await fetchNews()
    await saveToFile("newsFeed",news)
    return news
}


async function _updateNewsFeed() {
    if(gIntervalId) return
    gIntervalId = setInterval(() => _newsFeedCycle(), POLL_INTERVAL)
    return gIntervalId
}


async function _newsFeedCycle() {
    const newsFeed = loadFromFile("newsFeed")
    const news = await fetchNews()
    console.log("news:",news.length)
    
    const today = filterTodaysNewsFeed(news)
    console.log("today:",today.length)

    const unique = deduplicateNewsFeed(today, "newsFeed")
    console.log("unique:",unique.length)
    
    const filteredNews = [...newsFeed, ...unique]
    console.log("filteredNews:",filteredNews.length)
    await saveToFile("newsFeed",filteredNews)

    if (unique.length === 0) return
    
    await llmService.getRelevantNews(unique)
}






