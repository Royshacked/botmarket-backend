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

export async function fetchTickerNews(ticker) {
    try {
        const { from, to } = oneMonthAgoToTodayRange()
        const response = await axios.get(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`)
        return response.data
    } catch (error) {
        console.error('Error getting asset news', error)
        throw error
    }
}

export async function fetchTickerFinancials(ticker) {
    try {
        const response = await axios.get(`https://finnhub.io/api/v1/company-financials?symbol=${ticker}&token=${FINNHUB_API_KEY}`)
        return response.data
    } catch (error) {
        console.error('Error getting asset financials', error)
        throw error
    }
}

export async function fetchTickerSentiment(ticker) {
    try {
        const response = await axios.get(`https://finnhub.io/api/v1/company-sentiment?symbol=${ticker}&token=${FINNHUB_API_KEY}`)
        return response.data
    } catch (error) {
        console.error('Error getting asset sentiment', error)
        throw error
    }
}

export async function fetchTickerInsiderTrading(ticker) {
    try {
        const response = await axios.get(`https://finnhub.io/api/v1/company-insider-trading?symbol=${ticker}&token=${FINNHUB_API_KEY}`)
        return response.data
    } catch (error) {
        console.error('Error getting asset insider trading', error)
        throw error
    }
}

export async function fetchTickerPriceData(
    ticker,
    { resolution = 'D', from: fromSec, to: toSec } = {}
) {
    try {
        if (!FINNHUB_API_KEY || typeof FINNHUB_API_KEY !== 'string' || !FINNHUB_API_KEY.trim()) {
            throw new Error('FINNHUB_API_KEY is missing/empty. Set it in your environment (.env) before calling Finnhub.')
        }

        const to = Number.isFinite(toSec) ? toSec : Math.floor(Date.now() / 1000)
        const from =
            Number.isFinite(fromSec)
                ? fromSec
                : Math.floor((Date.now() - 365 * 24 * 60 * 60 * 1000) / 1000)

        const { data } = await axios.get(`https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=${resolution}&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`)
        
        if (!data || data.s !== 'ok' || !Array.isArray(data.t)) return []

        return data.t.map((timestamp, idx) => ({
            timestamp,
            open: data.o?.[idx],
            high: data.h?.[idx],
            low: data.l?.[idx],
            close: data.c?.[idx],
            volume: data.v?.[idx],
        }))
    } catch (error) {
        const status = error?.response?.status
        const body = error?.response?.data
        console.error('Error getting asset price data', { status, body, message: error?.message })
        throw error
    }
}