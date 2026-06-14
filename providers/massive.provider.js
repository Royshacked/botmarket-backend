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

export async function getTickerAggregates(ticker, options = {}) {
    const { timeSpan = 'day', multiplier, from, to } = options

    // Massive free tier blocks same-day intraday — route to Yahoo Finance instead
    if (timeSpan === 'minute' || timeSpan === 'hour') {
        return getYahooAggregates(ticker, options)
    }

  try {
        const response = await rest.getStocksAggregates(
        {
            stocksTicker: ticker,
            multiplier: multiplier,
            timespan: timeSpan,
            from: _toDateStr(from),
            to: _toDateStr(to),
            adjusted: "true",
            sort: "desc",
            limit: "50000"
        }
        );
        const results = Array.isArray(response?.results) ? response.results : []
        return results.map((bar) => ({
            timestamp: typeof bar?.t === 'number' ? Math.floor(bar.t / 1000) : undefined,
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

