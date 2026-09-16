import { logger } from '../services/logger.service.js'
import { getJson } from '../services/http.util.js'
import { config } from '../services/config.js'

const LOG = '[gnews]'
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

// GNews rate-limits per SECOND, not only per day. Two reads in one agent turn — "what's the news on
// the Fed, and anything on Nvidia" — is enough to earn a 429 on the second, which reached the model
// as "could not fetch the news" while the quota was fine. The shared pipe's retry (429 is retryable,
// Retry-After honoured) clears that — with a FLOOR under the jittered wait, because the default
// 0–300ms retry lands inside the same second and earns the same 429 again. This file used to carry
// its own fixed 1.4s one-retry around a bare fetch: the same mechanism a second time, without a
// timeout, and the number was right.
const RETRY_MIN_MS = 1_100

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
        return await getJson(url, { label: 'GNews /search', retryMinMs: RETRY_MIN_MS })
    } catch (error) {
        // GNews's own words ride on the error body; the message the tool reads should carry them.
        if (error?.status) {
            const detail = typeof error.body?.errors === 'string' ? error.body.errors : JSON.stringify(error.body?.errors ?? error.body ?? '')
            const err = new Error(`GNews API error ${error.status}: ${detail}`)
            err.status = error.status
            logger.error(LOG, 'Error getting GNews', err.message)
            throw err
        }
        logger.error(LOG, 'Error getting GNews', error)
        throw error
    }
}
