import { fetchNews, fetchTickerNews } from "../providers/finnhub.provider.js"
import { llmFilterService } from "./llmFilter.service.js"
import { deduplicateNewsFeed, filterTodaysNewsFeed, isCacheFresh, loadFromFile, saveToFile } from "./util.service.js"

export const newsService = {
    getNews,
    getNewsFeed,
    getRelevantNews,
    getNewsByTicker,
    getLatestNews,
}

async function getNews() {
    const news = await loadFromFile("news")
    return news || []
}

async function getNewsFeed() {
    const news = await fetchNews()
    console.log("news:",news.length)
    const today = filterTodaysNewsFeed(news)
    console.log("today:",today.length)

    const unique = await deduplicateNewsFeed(today, "news")
    console.log("unique:",unique.length)
    
    const filteredNews = [...news, ...unique]
    console.log("filteredNews:",filteredNews.length)
    await saveToFile("news",filteredNews)

    return unique || []
}

async function getRelevantNews(news) {
    if(news.length === 0) return
    const filtered = await llmFilterService.llmFilterNews(news)
    await saveToFile("relevantNews",filtered)
    return filtered || []
}


async function getNewsByTicker(ticker) {
    ticker = ticker.toUpperCase()
    const all = await loadFromFile("tickerNews")
    const entry = all[ticker]
    const lastFetchedAt = entry?.lastFetchedAt || 0

    if (isCacheFresh(lastFetchedAt, 60 * 60 * 1000)) return entry

    const articles = await fetchTickerNews(ticker)
    const updated = { ...all, [ticker]: { lastFetchedAt: Date.now(), articles } }
    await saveToFile("tickerNews", updated)
    return updated[ticker]
}


function getLatestNews(all, num=10) {
    let sorted = all
    sorted = sorted.articles.sort((a, b) => b.datetime - a.datetime)
    const latest = sorted.slice(0, num)
    return latest
}
