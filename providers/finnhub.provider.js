import dotenv from 'dotenv'
import axios from 'axios'
import { oneMonthAgoToTodayRange } from '../services/util.service.js'
import { logger } from '../services/logger.service.js'
import finnhub from 'finnhub'

dotenv.config()

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY
const finnhubClient = new finnhub.DefaultApi(FINNHUB_API_KEY)
// market news | company news | basic financials | ipo calendar | price target | earnings calendar | econmomic calendar | company profile |

function finnhubRequest(requestFn) {
    return new Promise((resolve, reject) => {
        requestFn((error, data) => {
            if (error) return reject(error)
            resolve(data)
        })
    })
}

function toFinnhubDate(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value

    const timestamp = typeof value === 'number' && value < 10000000000 ? value * 1000 : value
    const date = value instanceof Date ? value : new Date(timestamp)
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid Finnhub date: ${value}`)

    return date.toISOString().slice(0, 10)
}

export async function fetchMarketNews() {
    try {
        return await finnhubRequest(callback => finnhubClient.marketNews('general', {}, callback))
    } catch (error) {
        logger.error('Error getting market news', error)
        throw error
    }
}

export async function fetchCompanyNews(ticker,from=0,to=0) {
    try {
        const defaultRange = oneMonthAgoToTodayRange()
        if(!from) from = defaultRange.from
        if(!to) to = defaultRange.to
        from = toFinnhubDate(from)
        to = toFinnhubDate(to)
        return await finnhubRequest(callback => finnhubClient.companyNews(ticker, from, to, callback))
    } catch (error) {
        logger.error('Error getting company news', error)
        throw error
    }
}

export async function fetchCompanyProfile2(ticker) {
    try {
        return await finnhubRequest(callback => finnhubClient.companyProfile({ symbol: ticker }, callback))
    }
    catch (error) {
        logger.error('Error getting company profile', error)
        throw error
    }
}

export async function fetchEarningsCalendar(ticker,from=0,to=0) {
    try {
        const defaultRange = oneMonthAgoToTodayRange()
        if(!from) from = defaultRange.from
        if(!to) to = defaultRange.to
        from = toFinnhubDate(from)
        to = toFinnhubDate(to)
        return await finnhubRequest(callback => finnhubClient.earningsCalendar({
            symbol: ticker,
            from: from,
            to: to
        }, callback))
    }
    catch (error) {
        logger.error('Error getting earnings calendar', error)
        throw error
    }
}

export async function fetchFdaCalendar(from, to) {
    try {
        const f = toFinnhubDate(from || new Date())
        const t = toFinnhubDate(to   || new Date())
        const url = `https://finnhub.io/api/v1/drug/fda-calendar?from=${f}&to=${t}&token=${FINNHUB_API_KEY}`
        const res = await axios.get(url)
        const raw = Array.isArray(res.data) ? res.data : []
        return raw.map(r => ({
            date:    r.date,
            drug:    r.drugName    || r.name || '',
            action:  r.action      || '',
            company: r.company     || '',
            ticker:  r.ticker      || null,
            status:  r.status      || null,
        }))
    } catch (error) {
        logger.error('Error getting FDA calendar', error)
        return []
    }
}

