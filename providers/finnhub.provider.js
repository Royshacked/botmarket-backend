import { logger } from '../services/logger.service.js'
import { getDb } from './mongodb.provider.js'
import { createTtlCache } from '../services/ttlCache.util.js'
import { getJson } from '../services/http.util.js'
import { config } from '../services/config.js'

const LOG  = '[finnhub]'
const BASE = 'https://finnhub.io/api/v1'
const FINNHUB_API_KEY = config.finnhubApiKey

// Every Finnhub read goes through the shared pipe: timeout, meter, typed status, retry on 429/5xx.
// These were bare axios.get calls with NO timeout — a stalled connection held the caller forever —
// and none of them was counted, so the minute-summary never saw Finnhub at all.
const _get = (path, label) => getJson(`${BASE}${path}&token=${FINNHUB_API_KEY}`, { label: `Finnhub ${label}` })

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
        return await _get(`/calendar/earnings?from=${f}&to=${t}`, '/calendar/earnings')
    } catch (error) {
        logger.error(LOG, 'Error getting earnings calendar by date', error)
        return { earningsCalendar: [] }
    }
}

// Upcoming IPOs (free on Finnhub). Each row: date, symbol, name, exchange,
// price, numberOfShares, totalSharesValue, status (expected/priced/filed/…).
export async function fetchIpoCalendar(from, to) {
    try {
        const f = toFinnhubDate(from || new Date())
        const t = toFinnhubDate(to   || new Date())
        const data = await _get(`/calendar/ipo?from=${f}&to=${t}`, '/calendar/ipo')
        return Array.isArray(data?.ipoCalendar) ? data.ipoCalendar : []
    } catch (error) {
        logger.error(LOG, 'Error getting IPO calendar', error)
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
        logger.warn(LOG, 'profile cache read failed', err.message)
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
        logger.warn(LOG, 'profile cache write failed', err.message)
    }
}

export async function fetchCompanyProfile(symbol) {
    if (!symbol) return { name: null, logo: null }

    const cached = await _readProfileCache(symbol)
    if (cached) return cached

    try {
        const data = await _get(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`, '/stock/profile2')
        // A 200 (even an empty body for an unknown ticker) is authoritative and
        // stable, so cache it. Network / rate-limit errors throw → caught below,
        // NOT cached, so a later refresh retries them.
        const entry = { name: data?.name || null, logo: data?.logo || null }
        await _writeProfileCache(symbol, entry)
        return entry
    } catch (error) {
        logger.error(LOG, `Error getting company profile ${symbol}`, error?.message)
        return { name: null, logo: null }
    }
}



// ── News ──────────────────────────────────────────────────────────────────────
// Two feeds, both free on the key this file already uses for the calendars.
//
// WHY THESE AND NOT A TEXT SEARCH: company news here is keyed by SYMBOL, so a read for NVDA returns
// Nvidia's own coverage. The general-text alternative (GNews) matches words, and a search for
// "Nvidia" comes back full of competitor stories that merely mention it. GNews still owns the
// free-text half — a theme like "OPEC" has no ticker to key on — so the two sources split by the
// question, not by preference. news.service is where that split is decided.
//
// Both return rows already shaped like our internal article ({ datetime unix-sec, headline, summary,
// url, image, source }) — mapFinnhubArticle in newsArticle.service does the last mile.

/** Article rows for ONE symbol over a date window. Finnhub requires both dates. */
export async function fetchCompanyNews({ symbol, from, to } = {}) {
    if (!symbol) throw new Error('symbol is required')
    const f = toFinnhubDate(from || new Date(Date.now() - 30 * 86_400_000))
    const t = toFinnhubDate(to   || new Date())
    const data = await _get(`/company-news?symbol=${encodeURIComponent(symbol)}&from=${f}&to=${t}`, '/company-news')
    return Array.isArray(data) ? data : []
}

/**
 * The market-wide top-stories feed. No subject and no window — it is whatever is on the front page
 * right now, newest first, which is exactly what "what's the news today" asks for.
 */
export async function fetchGeneralNews({ category = 'general' } = {}) {
    const data = await _get(`/news?category=${encodeURIComponent(category)}`, '/news')
    return Array.isArray(data) ? data : []
}
