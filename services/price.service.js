import { getTickerAggregates } from "../providers/massive.provider.js"
import { loadCandlesFromFile, saveCandlesToFile } from "./util.service.js"


export const priceService = {
    getPriceData,
}


async function getPriceData(ticker, options) {
    const cached = await loadCandlesFromFile(ticker, options)
    const existingCandles = Array.isArray(cached?.candles) ? cached.candles : []

    const to = options.to ?? Date.now()
    let from = options.from

    const latestTs = _maxCandleTimestamp(existingCandles)
    if (latestTs != null) {
        const stepSec = _barDurationSeconds(options.timeSpan, options.multiplier)
        from = (latestTs + stepSec) * 1000
    }

    const fetchOptions = { ...options, from, to }
    const newCandles = await getTickerAggregates(ticker, fetchOptions)
    const merged = {
        lastFetchedAt: Date.now(),
        candles: _mergeCandlesDeduped(existingCandles, newCandles),
    }
    await saveCandlesToFile(merged, ticker, fetchOptions)
    return merged
}

function _barDurationSeconds(timeSpan, multiplier) {
    const m = Math.max(1, Math.trunc(Number(multiplier) || 1))
    switch (timeSpan) {
        case "minute":
            return m * 60
        case "hour":
            return m * 3600
        case "day":
            return m * 86400
        case "week":
            return m * 7 * 86400
        case "month":
            return m * 30 * 86400
        case "quarter":
            return m * 91 * 86400
        case "year":
            return m * 365 * 86400
        default:
            return m * 60
    }
}

function _mergeCandlesDeduped(existing, incoming) {
    const byTs = new Map()
    for (const c of existing) {
        if (c && Number.isFinite(c.timestamp)) byTs.set(c.timestamp, c)
    }
    for (const c of incoming) {
        if (c && Number.isFinite(c.timestamp)) byTs.set(c.timestamp, c)
    }
    return [...byTs.keys()].sort((a, b) => a - b).map((ts) => byTs.get(ts))
}

function _maxCandleTimestamp(candles) {
    let max = -Infinity
    for (const c of candles) {
        const t = c?.timestamp
        if (Number.isFinite(t) && t > max) max = t
    }
    return Number.isFinite(max) ? max : null
}

