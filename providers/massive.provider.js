import dotenv from 'dotenv'
import { restClient } from '@massive.com/client-js'
import { getTickerAggregates as getYahooAggregates } from './yahoofinance.provider.js'
import { logger } from '../services/logger.service.js'

dotenv.config()
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY
const rest = restClient(MASSIVE_API_KEY, 'https://api.massive.com')



function _toDateStr(ms) {
    return new Date(ms).toISOString().slice(0, 10)
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
        const results = Array.isArray(response?.results) ? response.results : []
        // Drop bars without a finite timestamp rather than emitting a candle with
        // `timestamp: undefined`, which would survive into the monitor's candle
        // merge as a malformed row.
        return results
            .filter((bar) => Number.isFinite(bar?.t))
            .map((bar) => ({
                timestamp: Math.floor(bar.t / 1000),
                open: bar?.o,
                high: bar?.h,
                low: bar?.l,
                close: bar?.c,
                volume: bar?.v,
            }))

  } catch (e) {
    logger.error(`couldn't get stocks aggregates for ${ticker}`, e);
    throw e
  }
}

