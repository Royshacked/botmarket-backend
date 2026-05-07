import dotenv from 'dotenv'
import axios from 'axios'
import { oneMonthAgoToTodayRange } from '../services/util.service.js'
// import finnhub from 'finnhub'

dotenv.config()

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY



export async function fetchNews() {
    try {
        const response = await axios.get(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`)
        return response.data
    } catch (error) {
        console.error('Error getting news feeds', error)
        throw error
    }
}

export async function fetchTickerNews(symbol) {
    try {
        const { from, to } = oneMonthAgoToTodayRange()
        const response = await axios.get(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`)
        return response.data
    } catch (error) {
        console.error('Error getting asset news', error)
        throw error
    }
}
