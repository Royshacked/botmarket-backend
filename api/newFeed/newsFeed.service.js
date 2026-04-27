import axios from 'axios'
import fs from 'fs'

import { getStartOfTodayUTC } from '../../services/util.service.js'

export const newsFeedService = {
    query,
}

const API_KEY = 'd7n2pfhr01qppri3bpngd7n2pfhr01qppri3bpo0' //finhubb api key
const POLL_INTERVAL = 1000 * 10
const newsFeed = _loadFromFile()
let gIntervalId
const seenIds = new Set();

_fetchAndSaveNewsFeed()
_setSeenIds(newsFeed)
// _updateNewsFeed()

async function query() {
    let filteredNewsFeed = newsFeed
    filteredNewsFeed = _filterTodaysNewsFeed(filteredNewsFeed)
    return Promise.resolve(filteredNewsFeed)
}

async function _fetchAndSaveNewsFeed() {
    if(newsFeed.length > 0) return
    try {
        const response = await axios.get(`https://finnhub.io/api/v1/news?category=general&token=${API_KEY}`)
        _saveToFile(response.data)
    } catch (error) {
        console.error('Error getting news feeds', error)
        throw error
    }
}

async function _updateNewsFeed() {
    if(gIntervalId) return
    gIntervalId = setInterval(async () => {
        try {
            const response = await axios.get(`https://finnhub.io/api/v1/news?category=general&token=${API_KEY}`)
            let newNewsFeed = _filterTodaysNewsFeed(response.data)
            newNewsFeed = _deduplicateNewsFeed(newNewsFeed)
            const updatedNewsFeed = [...newsFeed, ...newNewsFeed]
            // console.log('updatedNewsFeed', updatedNewsFeed.length)
            _saveToFile(updatedNewsFeed)
        } catch (error) {
            console.error('Error getting news feeds', error)
            throw error
        }
    }, POLL_INTERVAL)
    return gIntervalId
}

function _deduplicateNewsFeed(data) {
    const unique = []
    
    data.forEach(item => {
        if(!seenIds.has(item.datetime + item.headline)) {
            unique.push(item)
            seenIds.add(item.datetime + item.headline)
        }
    })
    return unique
}

function _filterTodaysNewsFeed(data) {
    const startOfTodayUTC = getStartOfTodayUTC()
    return data.filter(item => item.datetime >= startOfTodayUTC)
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
    data.forEach(item => seenIds.add(item.datetime + item.headline))
}