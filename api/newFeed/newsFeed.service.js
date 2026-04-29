import axios from 'axios'
import fs from 'fs'
import dotenv from 'dotenv'
dotenv.config()


import { getStartOfTodayUTC } from '../../services/util.service.js'

export const newsFeedService = {
    query,
}

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY

const newsFeed = _loadFromFile()

const POLL_INTERVAL = 1000 * 10
let gIntervalId

// _updateNewsFeed()

async function query() {
    let filteredNewsFeed = newsFeed
    filteredNewsFeed = _filterTodaysNewsFeed(filteredNewsFeed)
    return Promise.resolve(filteredNewsFeed)
}


async function _updateNewsFeed() {
    if(gIntervalId) return
    gIntervalId = setInterval(() => _newsCycle(), POLL_INTERVAL)
    return gIntervalId
}


async function _newsCycle() {
    const news = await _fetchNews()
    const today = _filterTodaysNewsFeed(news)
    const unique = _deduplicateNewsFeed(today)
    const updated = [...newsFeed, ...unique]
    _saveToFile(updated)
    console.log(updated.length)
    // if(unique.length === 0) {
    //     const updated = [...newsFeed, ...unique]
    //     _saveToFile(updated)
    //     return
    // }

    // const relevant = await llmFilter(unique)

}


async function _fetchNews() {
    try {
        const response = await axios.get(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`)
        return response.data
    } catch (error) {
        console.error('Error getting news feeds', error)
        throw error
    }
}


function _filterTodaysNewsFeed(data) {
    const startOfTodayUTC = getStartOfTodayUTC()
    return data.filter(item => item.datetime >= startOfTodayUTC)
}


function _deduplicateNewsFeed(data) {
    const unique = []
    const seenIds =  _setSeenIds(newsFeed)

    data.forEach(item => {
        if(!seenIds.has(item.datetime + item.headline)) {
            unique.push(item)
        }
    })
    return unique
}


function _saveToFile(data) {
    fs.writeFileSync('./data/newsFeeds.json', JSON.stringify(data, null, 2))
}


function _loadFromFile() {
    const data = fs.readFileSync('./data/newsFeeds.json', 'utf8')
    if(!data) return []
    return JSON.parse(data)
}


function _setSeenIds(data) {
    const seenIds = new Set()

    data.forEach(item => seenIds.add(item.datetime + item.headline))

    return seenIds
}

