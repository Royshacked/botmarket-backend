import fs from 'fs'
import dotenv from 'dotenv'
dotenv.config()


import { getStartOfTodayUTC } from '../../services/util.service.js'
import { llmService } from '../../services/llm.service.js'
import { fetchNews } from '../../providers/finnhub.provider.js'

export const newsFeedService = {
    query,
}

const POLL_INTERVAL = 1000 * 10
let gIntervalId

_getNewFeed()
_updateNewsFeed()

async function query() {
    let filteredNewsFeed = _loadFromFile("newsFeed")
    filteredNewsFeed = _filterTodaysNewsFeed(filteredNewsFeed)
    return Promise.resolve(filteredNewsFeed)
}

async function _getNewFeed() {
    const newsFeed = _loadFromFile("newsFeed")
    if(newsFeed.length > 0) return newsFeed
    const news =await fetchNews()
    return _saveToFile("newsFeed",news)
}

async function _updateNewsFeed() {
    if(gIntervalId) return
    gIntervalId = setInterval(() => _newsCycle(), POLL_INTERVAL)
    return gIntervalId
}


async function _newsCycle() {
    const newsFeed = _loadFromFile("newsFeed")
    const news = await fetchNews()
    console.log("news:",news.length)
    
    const today = _filterTodaysNewsFeed(news)
    console.log("today:",today.length)

    const unique = _deduplicateNewsFeed(today, "newsFeed")
    console.log("unique:",unique.length)
    
    const filteredNews = [...newsFeed, ...unique]
    console.log("filteredNews:",filteredNews.length)
    _saveToFile("newsFeed",filteredNews)

    if ("unique:",unique.length === 0) return
    
    _llmFilterNews(unique)
}


async function _llmFilterNews(news) {
    const relevantNews = _loadFromFile("relevantNews")
    try {
        const relevant = await llmService.filterRelevantNews(news)
        const unique = _deduplicateNewsFeed(relevant, "relevantNews")
        const llmFilteredNews = [...relevantNews, ...unique]
        _saveToFile("relevantNews",llmFilteredNews)
    } catch (error) {
        console.error("Error filtering news", error)
        return []
    }
}


function _filterTodaysNewsFeed(data) {
    const startOfTodayUTC = getStartOfTodayUTC()
    return data.filter(item => item.datetime >= startOfTodayUTC)
}


function _deduplicateNewsFeed(data, destination) {
    const news = _loadFromFile(destination)
    const today = _filterTodaysNewsFeed(news)
    if(today.length === 0) return data

    const unique = data.filter(item => !today.some(todayItem => todayItem.datetime === item.datetime && todayItem.headline === item.headline))
    return unique
}


function _saveToFile(name,data) {
    fs.writeFileSync(`./data/${name}.json`, JSON.stringify(data, null, 2))
}


function _loadFromFile(name) {
    const data = fs.readFileSync(`./data/${name}.json`, 'utf8')
    if(!data) return []
    return JSON.parse(data)
}

