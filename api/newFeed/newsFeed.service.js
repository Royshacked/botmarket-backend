import fs from 'fs'
import dotenv from 'dotenv'
dotenv.config()


import { deduplicateNewsFeed, filterTodaysNewsFeed, getStartOfTodayUTC, loadFromFile, saveToFile } from '../../services/util.service.js'
import { llmService } from '../../services/llmFilter.service.js'
import { fetchNews } from '../../providers/finnhub.provider.js'

export const newsFeedService = {
    query,
}

const POLL_INTERVAL = 1000 * 60 * 5
let gIntervalId

// _getNewFeed()
// _updateNewsFeed()

async function query() {
    const relevantNews = loadFromFile("relevantNews")
    return Promise.resolve(relevantNews)
}


async function _getNewsFeed() {
    const newsFeed = loadFromFile("newsFeed")
    if(newsFeed.length > 0) return newsFeed
    const news = await fetchNews()
    saveToFile("newsFeed",news)
    return news
}


async function _updateNewsFeed() {
    if(gIntervalId) return
    gIntervalId = setInterval(() => _newsCycle(), POLL_INTERVAL)
    return gIntervalId
}


async function _newsCycle() {
    const newsFeed = loadFromFile("newsFeed")
    const news = await fetchNews()
    console.log("news:",news.length)
    
    const today = filterTodaysNewsFeed(news)
    console.log("today:",today.length)

    const unique = deduplicateNewsFeed(today, "newsFeed")
    console.log("unique:",unique.length)
    
    const filteredNews = [...newsFeed, ...unique]
    console.log("filteredNews:",filteredNews.length)
    saveToFile("newsFeed",filteredNews)

    if ("unique:",unique.length === 0) return
    
    await llmService.getRelevantNews(unique)
}






