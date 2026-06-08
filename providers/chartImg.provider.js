/**
 * Chart-img provider — fetches TradingView chart images as base64.
 *
 * Docs: https://doc.chart-img.com/#advanced-chart
 * Env var required: CHART_IMG_API_KEY
 */

import YahooFinance from 'yahoo-finance2'
import { logger } from '../services/logger.service.js'

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })

const LOG     = '[chartImg.provider]'
const API_URL = 'https://api.chart-img.com/v2/tradingview/advanced-chart'

// Our internal timeframe → chart-img interval
const TF_MAP = {
    '1min': '1m', '5min': '5m', '15min': '15m', '30min': '30m',
    '1hr':  '1h', '2hr':  '2h', '4hr':   '4h',
    'day':  '1D', 'week': '1W', 'month':  '1M',
    // legacy
    'minutes': '5m', 'hours': '1h', 'daily': '1D', 'weekly': '1W', 'monthly': '1M',
}

/**
 * Fetch a TradingView chart image and return it as a base64 PNG string.
 *
 * @param {string}   symbol     asset ticker e.g. 'AAPL', 'BTCUSDT'
 * @param {string}   timeframe  internal timeframe e.g. '4hr', 'day'
 * @param {object[]} studies    chart-img study objects to overlay on the chart
 * @returns {Promise<string>}   base64-encoded PNG
 */
export async function fetchChartImage(symbol, timeframe, studies = []) {
    const apiKey = process.env.CHART_IMG_API_KEY
    if (!apiKey) throw new Error('CHART_IMG_API_KEY is not set')

    const tvSymbol = await toTVSymbol(symbol)
    const interval = TF_MAP[timeframe] ?? '1D'

    logger.info(LOG, `Fetching chart: ${tvSymbol} / ${interval} (${studies.length} studies)`)

    const res = await fetch(API_URL, {
        method:  'POST',
        headers: {
            'x-api-key':    apiKey,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            symbol:   tvSymbol,
            interval,
            width:    800,
            height:   600,
            theme:    'dark',
            style:    'candle',
            studies,
        }),
    })

    if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText)
        throw new Error(`chart-img ${res.status}: ${errText}`)
    }

    const buffer = await res.arrayBuffer()
    logger.info(LOG, `Chart fetched: ${tvSymbol} / ${interval} (${buffer.byteLength} bytes)`)
    return Buffer.from(buffer).toString('base64')
}

// Yahoo Finance exchange code → TradingView prefix
const YAHOO_TO_TV = {
    NMS: 'NASDAQ',  // NASDAQ Global Select Market
    NGM: 'NASDAQ',  // NASDAQ Global Market
    NCM: 'NASDAQ',  // NASDAQ Capital Market
    NYQ: 'NYSE',    // New York Stock Exchange
    PCX: 'AMEX',    // NYSE ARCA (chart-img uses AMEX)
    ASE: 'AMEX',    // American Stock Exchange
    BTS: 'CBOE',    // BATS/CBOE
}

const _tvCache = new Map()

/**
 * Convert an internal ticker to TradingView exchange:symbol format.
 * Looks up the real exchange via Yahoo Finance and caches the result.
 *
 * @param {string} symbol  e.g. 'AAPL', 'BTCUSDT'
 * @returns {Promise<string>}  e.g. 'NASDAQ:AAPL', 'AMEX:SPY', 'BINANCE:BTCUSDT'
 */
export async function toTVSymbol(symbol) {
    if (!symbol) return 'NASDAQ:SPY'
    const upper = symbol.toUpperCase()
    if (/USDT$|USDC$/i.test(upper)) return `BINANCE:${upper}`
    if (_tvCache.has(upper)) return _tvCache.get(upper)

    try {
        const q  = await yf.quote(upper)
        const tv = YAHOO_TO_TV[q.exchange] ?? 'NASDAQ'
        const result = `${tv}:${upper}`
        _tvCache.set(upper, result)
        logger.info(LOG, `Exchange resolved: ${upper} → ${result} (Yahoo: ${q.exchange})`)
        return result
    } catch {
        const fallback = `NASDAQ:${upper}`
        _tvCache.set(upper, fallback)
        return fallback
    }
}
