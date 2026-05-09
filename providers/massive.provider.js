import dotenv from 'dotenv'
import axios from 'axios'

dotenv.config()

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY

export async function fetchTickerPriceData(ticker, { resolution = 'D', from: fromSec, to: toSec } = {}) {
    try {
        if (!MASSIVE_API_KEY || typeof MASSIVE_API_KEY !== 'string' || !MASSIVE_API_KEY.trim()) {
            throw new Error('MASSIVE_API_KEY is missing/empty. Set it in your environment (.env) before calling Massive.')
        }

        const to = Number.isFinite(toSec) ? toSec : Math.floor(Date.now() / 1000)
        const from =
            Number.isFinite(fromSec)
                ? fromSec
                : Math.floor((Date.now() - 1 * 24 * 60 * 60 * 1000) / 1000)

        // Massive REST aggregates are served under /v2/aggs/... and use millisecond timestamps.
        // Docs: https://massive.com/docs/rest/stocks/aggregates/custom-bars
        const fromMs = from * 1000
        const toMs = to * 1000

        const { multiplier, timespan } = (() => {
            // Finnhub-style resolution compatibility: 'D' or number-of-minutes like '60'
            if (resolution === 'D' || resolution === '1D' || resolution === 'day') return { multiplier: 1, timespan: 'day' }
            const asNum = Number(resolution)
            if (Number.isFinite(asNum) && asNum > 0) return { multiplier: Math.trunc(asNum), timespan: 'minute' }
            return { multiplier: 1, timespan: 'day' }
        })()

        const url = `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${multiplier}/${timespan}/${fromMs}/${toMs}`
        const { data } = await axios.get(url, {
            params: {
                adjusted: true,
                sort: 'asc',
                limit: 50000,
                apiKey: MASSIVE_API_KEY,
            },
        })

        const results = data?.results
        if (!Array.isArray(results) || !results.length) return []

        // Normalize to the shape used elsewhere in the app.
        return results.map((bar) => ({
            timestamp: typeof bar?.t === 'number' ? Math.floor(bar.t / 1000) : undefined,
            open: bar?.o,
            high: bar?.h,
            low: bar?.l,
            close: bar?.c,
            volume: bar?.v,
        }))

    } catch (error) {
        const status = error?.response?.status
        const body = error?.response?.data
        const requestUrl = error?.config?.url
        console.error('Error getting asset price data', { status, requestUrl, body, message: error?.message })
        throw error
    }
}