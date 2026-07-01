import dotenv from 'dotenv'
import axios from 'axios'
import { logger } from '../services/logger.service.js'

dotenv.config()

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY

function toFinnhubDate(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value

    const timestamp = typeof value === 'number' && value < 10000000000 ? value * 1000 : value
    const date = value instanceof Date ? value : new Date(timestamp)
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid Finnhub date: ${value}`)

    return date.toISOString().slice(0, 10)
}

export async function fetchEarningsCalendarByDate(from, to) {
    try {
        const f = toFinnhubDate(from || new Date())
        const t = toFinnhubDate(to   || new Date())
        const url = `https://finnhub.io/api/v1/calendar/earnings?from=${f}&to=${t}&token=${FINNHUB_API_KEY}`
        const res = await axios.get(url)
        return res.data
    } catch (error) {
        logger.error('Error getting earnings calendar by date', error)
        return { earningsCalendar: [] }
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

