import dotenv from 'dotenv'
import { logger } from '../services/logger.service.js'
import { config } from '../services/config.js'

dotenv.config()

const GNEWS_API_KEY = config.gnewsApiKey
const GNEWS_API_URL = 'https://gnews.io/api/v4'
const GNEWS_QUERY_MAX = 200

/**
 * GNews rejects unquoted tokens with special characters (e.g. Inc.).
 * @see https://docs.gnews.io/endpoints/search-endpoint#query-syntax
 * @param {string} query
 * @returns {string}
 */
export function sanitizeGNewsQuery(query) {
    if (typeof query !== 'string') return ''
    const trimmed = query.trim()
    if (!trimmed) return ''

    const tokens = []
    let i = 0
    while (i < trimmed.length) {
        if (trimmed[i] === '"') {
            const end = trimmed.indexOf('"', i + 1)
            if (end === -1) {
                tokens.push(trimmed.slice(i))
                break
            }
            tokens.push(trimmed.slice(i, end + 1))
            i = end + 1
            while (i < trimmed.length && trimmed[i] === ' ') i++
            continue
        }
        const space = trimmed.indexOf(' ', i)
        const end = space === -1 ? trimmed.length : space
        const raw = trimmed.slice(i, end)
        if (raw) tokens.push(raw)
        i = end === -1 ? trimmed.length : end + 1
    }

    const sanitized = tokens
        .map((token) => {
            if (
                token.startsWith('"') &&
                token.endsWith('"') &&
                token.length >= 2
            ) {
                return token
            }
            if (/[^a-zA-Z0-9]/.test(token)) {
                const inner = token.replace(/"/g, '')
                return inner ? `"${inner}"` : ''
            }
            return token
        })
        .filter(Boolean)

    return sanitized.join(' ').slice(0, GNEWS_QUERY_MAX)
}

/**
 * GNews rate-limits per SECOND, not only per day. Two reads in one agent turn — "what's the news on
 * the Fed, and anything on Nvidia" — is enough to earn a 429 on the second, which reached the model
 * as "could not fetch the news" while the quota was fine. One retry after a pause clears that; a
 * quota that is genuinely spent still fails on the second try, which is the answer we want to give.
 */
const RETRY_STATUS = new Set([429])
const RETRY_DELAY_MS = 1_400
const _sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * @param {{ query: string, from?: string, to?: string, max?: number }} opts
 * @param {string} opts.query - Search query
 * @param {string} [opts.from] - ISO 8601 UTC; articles published on or after this time
 * @param {string} [opts.to] - ISO 8601 UTC; articles published on or before this time
 * @param {number} [opts.max=20] - Max articles to return (API default is 10)
 */
export async function fetchGNews({ query, from, to, max = 20, lang = 'en' } = {}) {
    const sanitized = sanitizeGNewsQuery(query)
    if (!sanitized) {
        throw new Error('query is required')
    }

    const params = new URLSearchParams({
        q: sanitized,
        max: String(max),
        lang,
        apikey: GNEWS_API_KEY ?? '',
    })
    if (from) params.set('from', from)
    if (to) params.set('to', to)

    const url = `${GNEWS_API_URL}/search?${params.toString()}`

    try {
        let data = await _get(url)
        if (data.status !== null && RETRY_STATUS.has(data.status)) {
            logger.warn('GNews rate-limited — one retry', { status: data.status })
            await _sleep(RETRY_DELAY_MS)
            data = await _get(url)
        }
        if (data.status !== null) {
            throw new Error(`GNews API error ${data.status}: ${data.detail}`)
        }
        return data.body
    } catch (error) {
        logger.error('Error getting GNews', error)
        throw error
    }
}

/**
 * One request. Returns `{ status: null, body }` on success and `{ status, detail }` on an HTTP
 * error, so the retry decision is made on a status rather than by re-parsing a thrown message.
 */
async function _get(url) {
    const response = await fetch(url)
    const body = await response.json()
    if (response.ok) return { status: null, body }

    const detail = typeof body?.errors === 'string'
        ? body.errors
        : JSON.stringify(body?.errors ?? body)
    return { status: response.status, detail }
}
