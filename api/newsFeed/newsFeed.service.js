import dotenv from 'dotenv'
dotenv.config()

import { loadFromFile } from '../../services/util.service.js'
import { newsService } from '../../services/news.service.js'

export const newsFeedService = {
    query,
}

const POLL_INTERVAL = 1000 * 10
let gIntervalId

// _updateNewsFeed()

async function query() {
    const relevantNews = await loadFromFile("relevantNews")
    return Promise.resolve(relevantNews)
}


async function _updateNewsFeed() {
    if(gIntervalId) return
    gIntervalId = setInterval(() => _newsFeedCycle(), POLL_INTERVAL)
    return gIntervalId
}


async function _newsFeedCycle() {
    const unique = await newsService.getNewsFeed()
    const relevant = await newsService.getRelevantNews(unique)
    return relevant || []
}






