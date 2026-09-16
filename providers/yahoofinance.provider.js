// Yahoo Finance — the QUOTE fallback, the candle fallback for what FMP does not carry, and the
// three reads only Yahoo serves (short interest, options context, the chart feed). The analytics
// that used to live here — risk, correlations, price action, cycles — were never Yahoo's: they are
// arithmetic over candles from ANY source and moved to services/priceAnalytics.service.js on
// 2026-09-16, where they read candles through the one router (candles.provider) instead of a private
// FMP-first copy of it.
import YahooFinance from 'yahoo-finance2'
import { compactNumber } from '../services/format.util.js'
import { createTtlCache } from '../services/ttlCache.util.js'
// FMP-first quotes (with Yahoo fallback). fmp.price is a leaf module, so importing it here is
// cycle-free — unlike candles.provider, which imports massive → this module. See reference_fmp_pricing.
import { getFmpQuoteYf } from './fmp.price.provider.js'

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })

// Short-TTL quote cache. A single agent turn can price the same ticker several
// times (get_quote, get_quotes, get_risk_metrics, and server-side sizing all
// hit yf.quote); within ~30s a price is effectively unchanged, so dedupe.
const QUOTE_TTL_MS  = 30_000
const QUOTE_CACHE_MAX = 500
const _quoteCache = createTtlCache({ ttlMs: QUOTE_TTL_MS, max: QUOTE_CACHE_MAX }) // SYMBOL -> data

async function _quote(ticker) {
    const symbol = String(ticker).toUpperCase()
    const hit = _quoteCache.get(symbol)
    if (hit) return hit
    // FMP real-time quote (mapped to yf field names); fall back to Yahoo for symbols FMP can't
    // price (some futures / index CFDs) or on a provider error.
    let data = null
    try { data = await getFmpQuoteYf(symbol) } catch { /* fall back */ }
    if (!data) data = await yf.quote(symbol)
    _quoteCache.set(symbol, data)
    return data
}

/**
 * Get a real-time quote for a ticker.
 * Returns a plain string ready to be fed to the LLM as a tool result.
 */
export async function getQuote(ticker) {
    const q = await _quote(ticker)
    const p = v => (v != null ? `$${Number(v).toFixed(2)}` : 'n/a')
    return [
        `${q.symbol}${q.shortName ? ` (${q.shortName})` : ''}`,
        `Price : ${p(q.regularMarketPrice)}`,
        `Open  : ${p(q.regularMarketOpen)}`,
        `High  : ${p(q.regularMarketDayHigh)}`,
        `Low   : ${p(q.regularMarketDayLow)}`,
        `Prev  : ${p(q.regularMarketPreviousClose)}`,
        `Chg   : ${q.regularMarketChangePercent != null ? q.regularMarketChangePercent.toFixed(2) + '%' : 'n/a'}`,
        `As of : ${q.regularMarketTime ? (q.regularMarketTime instanceof Date ? q.regularMarketTime : new Date(q.regularMarketTime * 1000)).toISOString() : 'n/a'}`,
    ].join('\n')
}

/**
 * Get a numeric price for a ticker (for server-side math, not LLM display).
 * Returns { symbol, price } or throws.
 */
export async function getNumericQuote(ticker) {
    const q = await _quote(ticker)
    return { symbol: q.symbol, price: q.regularMarketPrice ?? null }
}

/**
 * Numeric quote WITH the source timestamp — for the basis-offset math, which must know
 * how fresh the real-price reference is (a live quote vs a stale Friday close). `at` is
 * unix ms of the last price (Yahoo's regularMarketTime), or null.
 * @returns {Promise<{ symbol: string, price: number|null, at: number|null }>}
 */
export async function getNumericQuoteWithTime(ticker) {
    const q = await _quote(ticker)
    const t = q?.regularMarketTime
    const at = t == null ? null : (t instanceof Date ? t.getTime() : Number(t) * 1000)
    return {
        symbol:    q.symbol,
        price:     q.regularMarketPrice ?? null,
        prevClose: q.regularMarketPreviousClose ?? null,   // settled prior close — delay-free
        at,
    }
}

/**
 * Batch quotes for several tickers in one call. Returns an LLM-ready string
 * table so the agent doesn't have to fetch prices one ticker at a time.
 */
export async function getQuotes(tickers = []) {
    const symbols = [...new Set(tickers.map(t => String(t).toUpperCase()))].filter(Boolean)
    if (!symbols.length) return 'No tickers provided.'
    const results = await Promise.allSettled(symbols.map(s => _quote(s)))
    const p = v => (v != null ? `$${Number(v).toFixed(2)}` : 'n/a')
    const lines = results.map((r, i) => {
        if (r.status !== 'fulfilled' || !r.value) return `${symbols[i]}: quote unavailable`
        const q = r.value
        const chg = q.regularMarketChangePercent != null ? `${q.regularMarketChangePercent.toFixed(2)}%` : 'n/a'
        return `${q.symbol}: ${p(q.regularMarketPrice)} (${chg})`
    })
    return lines.join('\n')
}

// --- Short interest -----------------------------------------------------------
// Short interest is FINRA data: reported bi-monthly with a ~2-week lag, so it is
// inherently stale. We surface the `dateShortInterest` as-of prominently so the
// agent never treats it as a live read. Equities/ADRs only — ETFs, crypto, FX
// and futures have no short-interest figure.
const SI_TTL_MS = 12 * 60 * 60 * 1000
const _siCache = createTtlCache({ ttlMs: SI_TTL_MS }) // SYMBOL -> text

export async function getShortInterest(ticker) {
    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) return 'No ticker provided.'

    const hit = _siCache.get(sym)
    if (hit) return hit

    let stats, price
    try {
        const s = await yf.quoteSummary(sym, { modules: ['defaultKeyStatistics', 'price'] })
        stats = s?.defaultKeyStatistics || {}
        price = s?.price || {}
    } catch (err) {
        return `No short-interest data for ${sym} (${err.message}). This figure exists only for US-listed single stocks/ADRs — not ETFs, crypto, FX or futures.`
    }

    const sharesShort = stats.sharesShort
    if (sharesShort == null && stats.shortPercentOfFloat == null && stats.shortRatio == null) {
        return `No short-interest reported for ${sym}. This figure exists only for US-listed single stocks/ADRs — not ETFs, crypto, FX or futures.`
    }

    const pctFloat = stats.shortPercentOfFloat != null ? `${(stats.shortPercentOfFloat * 100).toFixed(2)}%` : null
    const daysCover = stats.shortRatio != null ? `${Number(stats.shortRatio).toFixed(1)} days` : null
    const prior = stats.sharesShortPriorMonth
    const moM = (sharesShort != null && prior != null && prior > 0)
        ? `${(((sharesShort - prior) / prior) * 100).toFixed(1)}% vs prior month`
        : null
    const asOf = stats.dateShortInterest
        ? (stats.dateShortInterest instanceof Date ? stats.dateShortInterest : new Date(stats.dateShortInterest)).toISOString().slice(0, 10)
        : 'unknown'

    const text = [
        `${sym}${price.shortName ? ` (${price.shortName})` : ''} — short interest`,
        pctFloat   ? `Short % of float: ${pctFloat}` : null,
        daysCover  ? `Days to cover (short ratio): ${daysCover}` : null,
        sharesShort != null ? `Shares short: ${compactNumber(sharesShort)}` : null,
        moM ? `Change: ${moM}` : null,
        `As of: ${asOf} (FINRA settlement date — reported bi-monthly with a ~2-week lag; treat as background, not a live read).`,
    ].filter(Boolean).join('\n')

    _siCache.set(sym, text)
    return text
}

// --- Options context ----------------------------------------------------------
// Nearest-expiry options snapshot: put/call ratio (by open interest AND volume),
// at-the-money implied volatility, and the available expiries. Quotes are
// 15-min delayed on the free feed. Equities/ETFs with listed options only.
const OPT_TTL_MS = 60 * 60 * 1000
const _optCache = createTtlCache({ ttlMs: OPT_TTL_MS }) // SYMBOL -> text

export async function getOptionsContext(ticker) {
    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) return 'No ticker provided.'

    const hit = _optCache.get(sym)
    if (hit) return hit

    let chain
    try {
        chain = await yf.options(sym)
    } catch (err) {
        return `No options data for ${sym} (${err.message}). Listed options exist for most US equities/ETFs — not for crypto, FX or futures here.`
    }

    const board = Array.isArray(chain?.options) ? chain.options[0] : null
    const calls = board?.calls || []
    const puts  = board?.puts  || []
    if (!calls.length && !puts.length) {
        return `No options chain found for ${sym}. Listed options exist for most US equities/ETFs — not for crypto, FX or futures here.`
    }

    const spot = chain?.quote?.regularMarketPrice ?? null
    const sum = (arr, k) => arr.reduce((a, c) => a + (Number(c[k]) || 0), 0)
    const oiCalls = sum(calls, 'openInterest'), oiPuts = sum(puts, 'openInterest')
    const volCalls = sum(calls, 'volume'),     volPuts = sum(puts, 'volume')
    const pcOI  = oiCalls  > 0 ? (oiPuts  / oiCalls ).toFixed(2) : 'n/a'
    const pcVol = volCalls > 0 ? (volPuts / volCalls).toFixed(2) : 'n/a'

    // ATM IV: contract whose strike is closest to spot, averaged across call+put.
    let atmIv = null
    if (spot != null) {
        const nearest = list => list.reduce((best, c) =>
            (best == null || Math.abs(c.strike - spot) < Math.abs(best.strike - spot)) ? c : best, null)
        const c = nearest(calls), p = nearest(puts)
        const ivs = [c?.impliedVolatility, p?.impliedVolatility].map(Number).filter(Number.isFinite)
        if (ivs.length) atmIv = `${((ivs.reduce((a, b) => a + b, 0) / ivs.length) * 100).toFixed(1)}%`
    }

    const expiries = (chain?.expirationDates || [])
        .slice(0, 6)
        .map(d => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10))
    const nearExp = board?.expirationDate
        ? (board.expirationDate instanceof Date ? board.expirationDate : new Date(board.expirationDate)).toISOString().slice(0, 10)
        : (expiries[0] || 'n/a')

    const text = [
        `${sym} — options context (nearest expiry ${nearExp}; quotes ~15-min delayed)`,
        spot != null ? `Spot: $${Number(spot).toFixed(2)}` : null,
        `Put/Call ratio — open interest: ${pcOI} | volume: ${pcVol}  (>1 = more puts/bearish-hedged, <1 = more calls/bullish)`,
        atmIv ? `ATM implied volatility: ${atmIv}` : null,
        expiries.length ? `Available expiries: ${expiries.join(', ')}` : null,
    ].filter(Boolean).join('\n')

    _optCache.set(sym, text)
    return text
}

// Map timeSpan/multiplier → Yahoo Finance interval string
function _toInterval(timeSpan, multiplier) {
    if (timeSpan === 'minute') {
        const supported = [1, 2, 5, 15, 30, 60, 90]
        const m = supported.includes(multiplier) ? multiplier : 5
        return `${m}m`
    }
    if (timeSpan === 'hour') return '1h'   // Yahoo has no 2hr/4hr — 1h is closest
    if (timeSpan === 'day')  return '1d'
    if (timeSpan === 'week') return '1wk'
    return '1mo'
}

/**
 * Fetch OHLCV candles from Yahoo Finance.
 * Returns same shape as massive.provider: [{ timestamp (unix sec), open, high, low, close, volume }]
 *
 * @param {string} ticker
 * @param {{ timeSpan?: string, multiplier?: number, from?: number, to?: number }} options
 *   from/to in Unix milliseconds (same convention as massive.provider)
 * @returns {Promise<import('../services/price.service.js').CandleObject[]>}
 */
export async function getTickerAggregates(ticker, options = {}) {
    const { timeSpan = 'day', multiplier = 1, from, to } = options

    const interval = _toInterval(timeSpan, multiplier)
    const period1  = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const period2  = to   ? new Date(to)   : new Date()

    const result = await yf.chart(ticker, { period1, period2, interval })

    return (result.quotes ?? [])
        .filter(q => q.open != null && q.close != null)
        .map(q => ({
            timestamp: Math.floor(q.date.getTime() / 1000),
            open:   q.open,
            high:   q.high,
            low:    q.low,
            close:  q.close,
            volume: q.volume ?? 0,
        }))
}
