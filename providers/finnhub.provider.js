import dotenv from 'dotenv'
import axios from 'axios'
import { logger } from '../services/logger.service.js'
import { getDb } from './mongodb.provider.js'
import { createTtlCache } from '../services/ttlCache.util.js'

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

// Upcoming IPOs (free on Finnhub). Each row: date, symbol, name, exchange,
// price, numberOfShares, totalSharesValue, status (expected/priced/filed/…).
export async function fetchIpoCalendar(from, to) {
    try {
        const f = toFinnhubDate(from || new Date())
        const t = toFinnhubDate(to   || new Date())
        const url = `https://finnhub.io/api/v1/calendar/ipo?from=${f}&to=${t}&token=${FINNHUB_API_KEY}`
        const res = await axios.get(url)
        return Array.isArray(res.data?.ipoCalendar) ? res.data.ipoCalendar : []
    } catch (error) {
        logger.error('Error getting IPO calendar', error)
        return []
    }
}

// Company name + logo per ticker. Profiles are effectively static, so they use a
// two-layer cache (in-process Map over Mongo), same pattern as fmp.provider. The
// Mongo layer means the one-time rate-limit burst on a busy earnings day only
// ever happens once — not once per process restart/deploy.
const PROFILE_COLLECTION = 'finnhub_profile_cache'
const PROFILE_TTL_MS     = 30 * 24 * 60 * 60 * 1000   // 30 days
const _profileMem        = createTtlCache({ ttlMs: PROFILE_TTL_MS, max: 1000 }) // SYMBOL -> { name, logo }

async function _readProfileCache(symbol) {
    const hit = _profileMem.get(symbol)
    if (hit) return hit

    try {
        const db  = await getDb()
        const doc = await db.collection(PROFILE_COLLECTION).findOne({ symbol })
        if (doc && Date.now() - doc.fetchedAt < PROFILE_TTL_MS) {
            const entry = { name: doc.name, logo: doc.logo }
            _profileMem.set(symbol, entry)
            return entry
        }
    } catch (err) {
        logger.warn('Finnhub profile cache read failed', err.message)
    }
    return null
}

async function _writeProfileCache(symbol, entry) {
    _profileMem.set(symbol, entry)
    try {
        const db = await getDb()
        await db.collection(PROFILE_COLLECTION).updateOne(
            { symbol },
            { $set: { symbol, ...entry, fetchedAt: Date.now() } },
            { upsert: true }
        )
    } catch (err) {
        logger.warn('Finnhub profile cache write failed', err.message)
    }
}

export async function fetchCompanyProfile(symbol) {
    if (!symbol) return { name: null, logo: null }

    const cached = await _readProfileCache(symbol)
    if (cached) return cached

    try {
        const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`
        const res = await axios.get(url)
        // A 200 (even an empty body for an unknown ticker) is authoritative and
        // stable, so cache it. Network / rate-limit errors throw → caught below,
        // NOT cached, so a later refresh retries them.
        const entry = { name: res.data?.name || null, logo: res.data?.logo || null }
        await _writeProfileCache(symbol, entry)
        return entry
    } catch (error) {
        logger.error('Error getting company profile', symbol, error?.message)
        return { name: null, logo: null }
    }
}


