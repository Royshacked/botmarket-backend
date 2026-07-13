// Financial Modeling Prep (FMP) real-time price provider.
//
// Companion to fmp.provider.js (fundamentals/earnings) — this one is live pricing:
// the `/stable/quote` endpoint returns a real-time last price plus the day's high/low
// in a single call, which is exactly what the paper engine needs to mark P&L and detect
// touch fills. Replaces the delayed/unstable Yahoo fast-quote (see reference_fmp_pricing).
//
// Coverage on the current key: equities, ETFs, crypto (…USD), forex (…USD). Futures and
// index CFDs are unreliable — callers keep a candle fallback for those. No batch endpoint
// on this tier, so multi-symbol callers loop single quotes.

import { logger }         from '../services/logger.service.js'
import { createTtlCache } from '../services/ttlCache.util.js'
import { getJson }        from '../services/http.util.js'

const LOG     = '[fmp.price]'
const BASE    = 'https://financialmodelingprep.com/stable'
const API_KEY = process.env.FMP_API_KEY

// Short TTL — quotes must stay fresh for touch-fill detection, but this collapses the
// overlapping mark/fill/equity callers to ~one real fetch per symbol per window.
const QUOTE_TTL_MS = Number(process.env.FMP_QUOTE_TTL_MS) || 3_000
const _quoteCache  = createTtlCache({ ttlMs: QUOTE_TTL_MS, max: 500 }) // SYMBOL -> { v: quote|null }

/**
 * Normalise an FMP `/quote` row into `{ price, dayHigh, dayLow, name }` (numbers, h/l
 * default to price for degenerate rows). Returns null when there is no usable price.
 * Pure — exported for unit testing.
 */
export function normalizeFmpQuote(row) {
    if (!row || typeof row !== 'object') return null
    const price = Number(row.price)
    if (!Number.isFinite(price) || price <= 0) return null
    const h = Number(row.dayHigh)
    const l = Number(row.dayLow)
    return {
        price,
        dayHigh: Number.isFinite(h) && h > 0 ? h : price,
        dayLow:  Number.isFinite(l) && l > 0 ? l : price,
        name:    typeof row.name === 'string' ? row.name : null,
    }
}

/**
 * Real-time quote for a symbol as `{ price, dayHigh, dayLow, name }`, or null when FMP
 * can't price it (uncovered symbol → empty array). Cached ~3s. Throws only on a transient
 * network/provider error so the caller can fall back rather than cache a miss.
 */
export async function getFmpQuoteFull(symbol) {
    const key = String(symbol || '').toUpperCase().trim()
    if (!key) return null

    const cached = _quoteCache.get(key)
    if (cached) return cached.v   // wrapper distinguishes "cached null" from "not cached"

    if (!API_KEY) throw new Error('FMP_API_KEY is not set')

    const arr = await getJson(`${BASE}/quote?symbol=${encodeURIComponent(key)}&apikey=${API_KEY}`, { label: `FMP /quote ${key}` })
    const quote = normalizeFmpQuote(Array.isArray(arr) ? arr[0] : arr)
    _quoteCache.set(key, { v: quote })   // cache null too (uncovered) — short TTL, avoids re-hitting
    if (quote == null) logger.info(LOG, `no FMP price for ${key} (uncovered on this plan)`)
    return quote
}

/** Real-time last price for a symbol, or null. Convenience over getFmpQuoteFull. */
export async function getFmpQuote(symbol) {
    return (await getFmpQuoteFull(symbol))?.price ?? null
}
