import dotenv from 'dotenv'
import { restClient } from '@massive.com/client-js'
import { getTickerAggregates as getYahooAggregates } from './yahoofinance.provider.js'
import { logger } from '../services/logger.service.js'
import { config } from '../services/config.js'

dotenv.config()
const MASSIVE_API_KEY = config.massiveApiKey
const rest = restClient(MASSIVE_API_KEY, 'https://api.massive.com')



function _toDateStr(ms) {
    return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Massive aggregate rows → the canonical CandleObject[] (epoch SECONDS, OLDEST FIRST).
 * Pure, and exported for the unit test.
 *
 * ASCENDING is the provider contract every caller reads by. The request below stays `sort: desc`
 * so that if `limit` ever truncates we keep the MOST RECENT bars — but the response has to be
 * flipped back before it leaves this module. FMP and Yahoo both emit oldest-first and everything
 * downstream assumes it: `.slice(-n)` means "the latest n" (marketData.tools._fetchCandleRows,
 * assess.shared.candlesText), `.at(-1)` means "the newest bar" (monitorUtils.fetchLastPrice),
 * the indicators and the SMC engine walk the array forward in time, and the chart draws it left
 * to right. Served desc, all of that silently read the series BACKWARDS — the chart's right edge
 * was the OLDEST bar with the live-quote tick painted onto it, and every agent tool computed
 * RSI/EMA/ATR/structure on a time-reversed window. Only price.service was immune (it re-sorts
 * on read), which is why this survived: Massive is the FALLBACK, so it only surfaced when FMP
 * declined the spec (week/month, futures/index/broker symbols) or was rate-limited.
 *
 * @param {Array<{t:number,o:number,h:number,l:number,c:number,v:number}>|undefined} results
 * @returns {Array<{timestamp:number,open:number,high:number,low:number,close:number,volume:number}>}
 */
export function normalizeAggregateRows(results) {
    // Drop bars without a finite timestamp rather than emitting a candle with
    // `timestamp: undefined`, which would survive into the monitor's candle
    // merge as a malformed row.
    return (Array.isArray(results) ? results : [])
        .filter((bar) => Number.isFinite(bar?.t))
        .map((bar) => ({
            timestamp: Math.floor(bar.t / 1000),
            open: bar?.o,
            high: bar?.h,
            low: bar?.l,
            close: bar?.c,
            volume: bar?.v,
        }))
        .sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Fetch OHLCV candles from Massive (equities daily/weekly; intraday routes to Yahoo).
 *
 * @param {string} ticker
 * @param {{ timeSpan?: string, multiplier?: number, from?: number, to?: number }} options
 *   from/to in Unix milliseconds
 * @returns {Promise<import('../services/price.service.js').CandleObject[]>}
 */
export async function getTickerAggregates(ticker, options = {}) {
    const { timeSpan = 'day', multiplier, from, to } = options

    // Massive free tier blocks same-day intraday — route to Yahoo Finance instead
    if (timeSpan === 'minute' || timeSpan === 'hour') {
        return getYahooAggregates(ticker, options)
    }

    // Default the window bounds so a caller that omits `to` (or `from`) can't crash
    // `_toDateStr(undefined)` with "Invalid time value". Callers on the FMP-first router
    // reach here only for symbols FMP doesn't serve (futures / index / broker), and some
    // (the Hermes monitor's candle read) pass `from` only — cover them all.
    const toMs   = Number.isFinite(to)   ? to   : Date.now()
    const fromMs = Number.isFinite(from) ? from : toMs - 60 * 24 * 60 * 60 * 1000

  try {
        const response = await rest.getStocksAggregates(
        {
            stocksTicker: ticker,
            multiplier: multiplier,
            timespan: timeSpan,
            from: _toDateStr(fromMs),
            to: _toDateStr(toMs),
            adjusted: "true",
            sort: "desc",
            limit: "50000"
        }
        );
        return normalizeAggregateRows(response?.results)

  } catch (e) {
    logger.error(`couldn't get stocks aggregates for ${ticker}`, e);
    throw e
  }
}

