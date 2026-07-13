import YahooFinance from 'yahoo-finance2'
import { compactNumber } from '../services/format.util.js'
import { createTtlCache } from '../services/ttlCache.util.js'
import {
    logReturns as _logReturns,
    stdev as _stdev,
    atr as _atr,
    pearson as _pearson,
    correlationMatrix as _correlationMatrix,
} from '../services/priceStats.util.js'
import {
    findExtrema as _findExtrema,
    cycleStats as _cycleStats,
    tdToCalDays as _tdToCalDays,
    addCalDays as _addCalDays,
    fmtDuration as _fmtDuration,
    fmtDateTimeUTC as _fmtDateTimeUTC,
} from '../services/cycleAnalysis.service.js'
// FMP-first data sourcing for quotes + analytics candles (with Yahoo fallback). fmp.price is a
// leaf module, so importing it here is cycle-free — unlike candles.provider, which imports
// massive → this module. See reference_fmp_pricing.
import { getFmpQuoteYf, getFmpCandles } from './fmp.price.provider.js'

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
export async function getCompanyName(ticker) {
    try {
        const q = await _quote(ticker)
        return q?.shortName || q?.longName || ticker
    } catch {
        return ticker
    }
}

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

// Fast-refresh quote for the paper touch-fill + mark loops. They sample every ~3s and
// need a price fresher than the 30s agent cache gives — but lowering that shared cache
// would multiply yf.quote calls across the WHOLE app (agent tools + sizing) and invite
// 429s. So this rides a SEPARATE short-TTL cache: the extra load stays scoped to the
// small set of active paper symbols, deduped to ~one fetch per symbol per TTL.
const FAST_QUOTE_TTL_MS = Number(process.env.PAPER_FAST_QUOTE_TTL_MS) || 3_000
const _fastQuoteCache   = createTtlCache({ ttlMs: FAST_QUOTE_TTL_MS, max: QUOTE_CACHE_MAX }) // SYMBOL -> data

/**
 * Like getNumericQuote, but on a 3s cache instead of 30s — for the paper loops that
 * need sub-minute freshness. Returns { symbol, price } or throws.
 */
export async function getNumericQuoteFast(ticker) {
    const symbol = String(ticker).toUpperCase()
    const hit = _fastQuoteCache.get(symbol)
    const data = hit ?? await yf.quote(symbol)
    if (!hit) _fastQuoteCache.set(symbol, data)
    return { symbol: data.symbol, price: data.regularMarketPrice ?? null }
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

// --- Risk / correlation helpers (computed from daily candles) ---------------

const TRADING_DAYS = 252

// FMP-first candle fetch for the analytics functions (risk / correlation / price-action /
// cycle). FMP daily is verified-aligned with the current provider (ET-midnight); fall back to
// the local Yahoo aggregates for symbols/timeframes FMP doesn't serve.
async function _candles(sym, opts) {
    try {
        const fmp = await getFmpCandles(sym, opts)
        if (Array.isArray(fmp) && fmp.length) return fmp
    } catch { /* fall through to Yahoo */ }
    return getTickerAggregates(sym, opts)
}

// Fetch ~`days` calendar days of daily OHLC for a ticker.
async function _dailyCandles(ticker, days = 365) {
    const from = Date.now() - days * 24 * 60 * 60 * 1000
    return _candles(ticker, { timeSpan: 'day', multiplier: 1, from, to: Date.now() })
}

/**
 * Annualized volatility + ATR for a ticker, as an LLM-ready string.
 * Enables risk-based sizing and sensible stop distances.
 */
export async function getRiskMetrics(ticker) {
    const sym = String(ticker).toUpperCase()
    const candles = await _dailyCandles(sym, 365)
    if (candles.length < 20) return `${sym}: not enough price history for risk metrics.`
    const closes = candles.map(c => c.close)
    const annVol = _stdev(_logReturns(closes)) * Math.sqrt(TRADING_DAYS)
    const atr    = _atr(candles, 14)
    const last   = closes[closes.length - 1]
    const atrPct = atr != null && last > 0 ? (atr / last) * 100 : null
    return [
        `${sym} — risk (1y daily):`,
        `Annualized volatility: ${(annVol * 100).toFixed(1)}%`,
        `ATR(14): ${atr != null ? `$${atr.toFixed(2)}` : 'n/a'}${atrPct != null ? ` (${atrPct.toFixed(1)}% of price)` : ''}`,
        `Latest close: $${last.toFixed(2)}`,
    ].join('\n')
}

/**
 * Annualized volatility for a ticker as a raw number (for server-side math).
 * Returns null when there is not enough price history.
 */
export async function getAnnualizedVolRaw(ticker) {
    const sym = String(ticker).toUpperCase()
    const candles = await _dailyCandles(sym, 365)
    if (candles.length < 20) return null
    return _stdev(_logReturns(candles.map(c => c.close))) * Math.sqrt(TRADING_DAYS)
}

// Shared core for correlation computation — returns { symbols, matrix } or null.
async function _computeCorrelationData(tickers) {
    const symbols = [...new Set(tickers.map(t => String(t).toUpperCase()))].filter(Boolean)
    if (symbols.length < 2) return null

    const series = await Promise.all(symbols.map(async sym => {
        const candles = await _dailyCandles(sym, 365)
        const byDay   = new Map(candles.map(c => [c.timestamp, c.close]))
        return { sym, byDay }
    }))

    const common = series.reduce((acc, s) => acc.filter(ts => s.byDay.has(ts)), [...series[0].byDay.keys()])
    if (common.length < 20) return null
    common.sort((a, b) => a - b)

    const returns = series.map(s => _logReturns(common.map(ts => s.byDay.get(ts))))
    const matrix  = _correlationMatrix(returns)
    return { symbols, matrix }
}

/**
 * Pairwise Pearson correlation matrix as raw numbers — for server-side math.
 * Returns { symbols: string[], matrix: number[][] } or null on failure.
 */
export async function getCorrelationsRaw(tickers = []) {
    return _computeCorrelationData(tickers)
}

/**
 * Fetch daily candles once per ticker and derive both annualized volatilities
 * and the correlation matrix in a single pass — half the Yahoo API calls vs
 * calling getAnnualizedVolRaw + getCorrelationsRaw separately.
 *
 * Returns { vols: Array<number|null>, corrData: {symbols,matrix}|null }
 * where vols[i] corresponds to tickers[i] (order and duplicates preserved).
 */
export async function getVolsAndCorrelationsRaw(tickers = []) {
    const unique = [...new Set(tickers.map(t => String(t || '').toUpperCase()))].filter(Boolean)
    if (unique.length === 0) return { vols: tickers.map(() => null), corrData: null }

    const seriesArr = await Promise.all(unique.map(async sym => {
        try {
            const candles = await _dailyCandles(sym, 365)
            return { sym, candles }
        } catch {
            return { sym, candles: [] }
        }
    }))
    const candlesBySym = Object.fromEntries(seriesArr.map(s => [s.sym, s.candles]))

    const vols = tickers.map(t => {
        const candles = candlesBySym[String(t || '').toUpperCase()] ?? []
        if (candles.length < 20) return null
        return _stdev(_logReturns(candles.map(c => c.close))) * Math.sqrt(TRADING_DAYS)
    })

    let corrData = null
    if (unique.length >= 2) {
        const series = seriesArr.map(({ sym, candles }) => ({
            sym, byDay: new Map(candles.map(c => [c.timestamp, c.close])),
        }))
        const common = series.reduce(
            (acc, s) => acc.filter(ts => s.byDay.has(ts)),
            [...series[0].byDay.keys()]
        )
        if (common.length >= 20) {
            common.sort((a, b) => a - b)
            const returns = series.map(s => _logReturns(common.map(ts => s.byDay.get(ts))))
            const matrix  = _correlationMatrix(returns)
            corrData = { symbols: unique, matrix }
        }
    }

    return { vols, corrData }
}

/**
 * Pairwise Pearson correlation of daily returns across tickers, as an
 * LLM-ready matrix string. Makes "diversified" checkable instead of guessed.
 */
export async function getCorrelations(tickers = []) {
    const unique = [...new Set(tickers.map(t => String(t).toUpperCase()))].filter(Boolean)
    if (unique.length < 2) return 'Provide at least two distinct tickers to compute correlations.'
    const data = await _computeCorrelationData(unique)
    if (!data) return 'Not enough overlapping price history to compute correlations.'

    const { symbols, matrix } = data
    const pad    = s => String(s).padStart(7)
    const header = '       ' + symbols.map(pad).join('')
    const rows   = symbols.map((sym, i) =>
        pad(sym) + symbols.map((_, j) => pad(matrix[i][j].toFixed(2))).join('')
    )
    return ['Correlation matrix (1y daily returns):', header, ...rows].join('\n')
}

/**
 * Recent price-action summary for a ticker, as an LLM-ready string: latest
 * close, % moves over 1d/5d/1m/3m, position within the 1y range, and recent
 * volume vs its average. Grounds momentum/trend reads for the scanner without
 * the agent having to crunch raw candles.
 */
export async function getPriceAction(ticker) {
    const sym = String(ticker).toUpperCase()
    const candles = await _dailyCandles(sym, 365)
    if (candles.length < 10) return `${sym}: not enough price history for a trend read.`

    const closes = candles.map(c => c.close)
    const last   = closes[closes.length - 1]
    const ago    = n => closes.length > n ? closes[closes.length - 1 - n] : null
    const chg    = prev => (prev != null && prev > 0) ? `${(((last - prev) / prev) * 100).toFixed(1)}%` : 'n/a'

    const hi52 = Math.max(...closes)
    const lo52 = Math.min(...closes)
    const rangePos = hi52 > lo52 ? ((last - lo52) / (hi52 - lo52)) * 100 : null

    const vols    = candles.map(c => c.volume).filter(v => v > 0)
    const avgVol  = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null
    const lastVol = candles[candles.length - 1].volume
    const volRel  = (avgVol && lastVol) ? `${(lastVol / avgVol).toFixed(1)}× avg` : 'n/a'

    return [
        `${sym} — price action (1y daily):`,
        `Last close: $${last.toFixed(2)}`,
        `Change: 1d ${chg(ago(1))} | 5d ${chg(ago(5))} | 1m ${chg(ago(21))} | 3m ${chg(ago(63))}`,
        `1y range: $${lo52.toFixed(2)} – $${hi52.toFixed(2)}${rangePos != null ? ` (at ${rangePos.toFixed(0)}% of range)` : ''}`,
        `Last volume: ${volRel}`,
    ].join('\n')
}

// --- Cycle analysis -----------------------------------------------------------

// Intraday price-cycle fetch spec per rung: how far back to pull, and each bar's wall-clock minutes
// (to render bar-counts as approximate spans). Only these rungs run an intraday cycle; ≥ 2hr uses the
// daily path. Windows respect Yahoo's intraday history limits (1m ~ days, 5–30m ~ weeks, 1h ~ months).
// Windows sit safely INSIDE Yahoo's intraday history caps (1m ≤ 7d, 2–90m ≤ 60d, 1h ≤ 730d) —
// a request at the exact boundary is rejected, so stay a few days under.
const INTRADAY_CYCLE_CFG = {
    '1min':  { timeSpan: 'minute', multiplier: 1,  windowDays: 6,   barMinutes: 1 },
    '5min':  { timeSpan: 'minute', multiplier: 5,  windowDays: 55,  barMinutes: 5 },
    '15min': { timeSpan: 'minute', multiplier: 15, windowDays: 55,  barMinutes: 15 },
    '30min': { timeSpan: 'minute', multiplier: 30, windowDays: 55,  barMinutes: 30 },
    '1hr':   { timeSpan: 'hour',   multiplier: 1,  windowDays: 180, barMinutes: 60 },
}

// Intraday price cycle: run the SAME extrema/interval math as the daily path, but measured in BARS of
// the requested rung and rendered as approximate wall-clock spans + timestamps. A session-scale rhythm,
// not a multi-day swing. Never throws upward beyond the provider's normal fetch errors.
async function _intradayPriceCycle(sym, timeframe) {
    const cfg  = INTRADAY_CYCLE_CFG[timeframe]
    const from = Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000
    const candles = await _candles(sym, { timeSpan: cfg.timeSpan, multiplier: cfg.multiplier, from, to: Date.now() })
    if (!candles || candles.length < 40) return `${sym}: not enough ${timeframe} history for an intraday cycle read.`

    const closes = candles.map(c => c.close)
    const { peaks, troughs } = _findExtrema(closes)
    const troughStats = _cycleStats(troughs)
    const peakStats   = _cycleStats(peaks)

    const lines = [`${sym} — intraday cycle analysis (${timeframe} bars):`]
    if (!troughStats && !peakStats) {
        lines.push('No clear repeating intraday cycle detected in the available history.')
        return lines.join('\n')
    }

    const useTrough   = Boolean(troughStats)
    const stats       = troughStats ?? peakStats
    const anchors     = useTrough ? troughs : peaks
    const anchorLabel = useTrough ? 'trough' : 'peak'
    const label       = useTrough ? 'trough-to-trough' : 'peak-to-peak'
    const span        = n => _fmtDuration(n * cfg.barMinutes)
    const project     = n => _fmtDateTimeUTC(Date.now() + n * cfg.barMinutes * 60 * 1000)

    lines.push(`\nDominant intraday cycle (${label}):`)
    lines.push(`Cycle length: ~${stats.mean} bars (~${span(stats.mean)})`)
    lines.push(`Consistency: ${Math.round(stats.consistency * 100)}% of cycles within ±35% of mean (${stats.count} cycles observed)`)

    const lastIdx    = anchors[anchors.length - 1]
    const barsSince  = closes.length - 1 - lastIdx
    lines.push(`Last ${anchorLabel}: ${_fmtDateTimeUTC(candles[lastIdx].timestamp * 1000)} at $${closes[lastIdx].toFixed(2)}`)
    lines.push(`Bars since last ${anchorLabel}: ${barsSince} (~${span(barsSince)})`)

    const half = Math.round(stats.mean / 2)
    if (barsSince < half) {
        lines.push(`Current phase: UPSWING — ${barsSince}/${half} bars through`)
        lines.push(`Estimated peak: ~${project(half - barsSince)} (±${span(stats.std)})`)
    } else if (barsSince < stats.mean) {
        lines.push(`Current phase: DOWNSWING — ${barsSince - half} bars into the down leg`)
        lines.push(`Estimated next ${anchorLabel}: ~${project(stats.mean - barsSince)} (±${span(stats.std)})`)
    } else {
        lines.push(`Current phase: EXTENDED — ${barsSince} bars since last ${anchorLabel} (cycle avg is ${stats.mean}). Possible cycle break or low-volatility drift.`)
    }

    if (stats.consistency >= 0.7) {
        lines.push(`Cycle reliability: STRONG (${Math.round(stats.consistency * 100)}% hit rate) — usable as an intraday timing signal.`)
    } else if (stats.consistency >= 0.5) {
        lines.push(`Cycle reliability: MODERATE (${Math.round(stats.consistency * 100)}% hit rate) — treat as context, not a precise timer.`)
    } else {
        lines.push(`Cycle reliability: WEAK (${Math.round(stats.consistency * 100)}% hit rate) — irregular pattern, use with caution.`)
    }
    lines.push(`\n(Timed on ${timeframe} bars over ~${cfg.windowDays}d — a session-scale rhythm; wall-clock spans are approximate as they ignore overnight gaps.)`)
    return lines.join('\n')
}

/**
 * Detect recurring price cycles or calendar-window seasonality for a ticker.
 *
 * mode: "price"    — peak-to-peak / trough-to-trough cycle detection
 *       "calendar" — how this stock behaves in a specific calendar window each year
 *
 * calendarWindow (for mode "calendar"):
 *   { month_start, month_end, day_start?, day_end? }
 *   month_start/month_end are 1-based (Jan=1). day_start/day_end optional (defaults: 1/last day).
 *
 * lookbackYears: how many years of history to use (default 4).
 *
 * timeframe: the resolution the cycle is measured on. Sub-hourly-to-hourly rungs (1min–1hr) run a
 *   PRICE cycle on intraday bars (a session-scale rhythm). Everything ≥ 2hr — and calendar mode —
 *   runs on daily history (multi-day swing / yearly seasonality), the original behavior.
 */
export async function getCycleAnalysis(ticker, mode, calendarWindow = null, lookbackYears = 4, timeframe = 'day') {
    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) return 'No ticker provided.'

    // Intraday price cycle: only for a price read on a sub-hourly-to-hourly rung. Calendar
    // seasonality is inherently daily/yearly, so it always uses the daily path below.
    if (mode === 'price' && INTRADAY_CYCLE_CFG[timeframe]) {
        return _intradayPriceCycle(sym, timeframe)
    }

    const calDaysNeeded = mode === 'calendar'
        ? (lookbackYears + 1) * 365 + 60
        : 730   // 2 years for price cycle detection

    const candles = await _dailyCandles(sym, calDaysNeeded)
    if (candles.length < 60) return `${sym}: not enough price history for cycle analysis.`

    const closes = candles.map(c => c.close)
    const dates  = candles.map(c => new Date(c.timestamp * 1000))
    const lines  = [`${sym} — cycle analysis:`]

    // ── Price cycle ─────────────────────────────────────────────────────────
    if (mode === 'price') {
        const { peaks, troughs } = _findExtrema(closes)

        const troughStats = _cycleStats(troughs)
        const peakStats   = _cycleStats(peaks)

        if (!troughStats && !peakStats) {
            lines.push('No clear repeating cycle detected in the available price history.')
            return lines.join('\n')
        }

        const stats = troughStats ?? peakStats
        const label = troughStats ? 'trough-to-trough' : 'peak-to-peak'
        const anchors = troughStats ? troughs : peaks
        const anchorLabel = troughStats ? 'trough' : 'peak'

        lines.push(`\nDominant price cycle (${label}):`)
        lines.push(`Cycle length: ~${stats.mean} trading days (~${_tdToCalDays(stats.mean)} calendar days)`)
        lines.push(`Consistency: ${Math.round(stats.consistency * 100)}% of cycles within ±35% of mean (${stats.count} cycles observed)`)

        const lastIdx  = anchors[anchors.length - 1]
        const daysSince = closes.length - 1 - lastIdx
        const lastDate  = dates[lastIdx].toISOString().slice(0, 10)
        const lastPrice = closes[lastIdx]

        lines.push(`Last ${anchorLabel}: ${lastDate} at $${lastPrice.toFixed(2)}`)
        lines.push(`Days since last ${anchorLabel}: ${daysSince} trading days (~${_tdToCalDays(daysSince)} calendar days)`)

        const halfCycle = Math.round(stats.mean / 2)
        const today = new Date()

        if (daysSince < halfCycle) {
            const daysToMidpoint  = halfCycle - daysSince
            const estOpposite     = _addCalDays(today, _tdToCalDays(daysToMidpoint))
            lines.push(`Current phase: UPSWING — ${daysSince}/${halfCycle} trading days through`)
            lines.push(`Estimated peak: ~${estOpposite} (±${_tdToCalDays(stats.std)} calendar days)`)
        } else if (daysSince < stats.mean) {
            const daysIntoDown    = daysSince - halfCycle
            const daysToNextAnchor = stats.mean - daysSince
            const estNext         = _addCalDays(today, _tdToCalDays(daysToNextAnchor))
            lines.push(`Current phase: DOWNSWING — ${daysIntoDown} trading days into the down leg`)
            lines.push(`Estimated next ${anchorLabel}: ~${estNext} (±${_tdToCalDays(stats.std)} calendar days)`)
        } else {
            lines.push(`Current phase: EXTENDED — ${daysSince} trading days since last ${anchorLabel} (cycle avg is ${stats.mean}). Possible cycle break or low-volatility drift.`)
        }

        // Conviction signal
        if (stats.consistency >= 0.7) {
            lines.push(`Cycle reliability: STRONG (${Math.round(stats.consistency * 100)}% hit rate) — usable as a timing signal.`)
        } else if (stats.consistency >= 0.5) {
            lines.push(`Cycle reliability: MODERATE (${Math.round(stats.consistency * 100)}% hit rate) — treat as context, not a precise timer.`)
        } else {
            lines.push(`Cycle reliability: WEAK (${Math.round(stats.consistency * 100)}% hit rate) — irregular pattern, use with caution.`)
        }
    }

    // ── Calendar cycle ───────────────────────────────────────────────────────
    if (mode === 'calendar') {
        if (!calendarWindow || !calendarWindow.month_start) {
            return `${sym}: calendar mode requires a calendarWindow with at least month_start.`
        }

        const { month_start, month_end, day_start = 1, day_end = 31 } = calendarWindow
        const mEnd = month_end ?? month_start

        const currentYear = new Date().getFullYear()
        const results = []

        for (let year = currentYear - lookbackYears; year <= currentYear; year++) {
            const winStart = new Date(year, month_start - 1, day_start)
            const winEnd   = new Date(year, mEnd - 1, day_end)
            // Clamp end to today for current year
            const clampedEnd = year === currentYear ? new Date(Math.min(winEnd.getTime(), Date.now())) : winEnd

            const inWindow = candles.filter(c => {
                const d = dates[candles.indexOf(c)]
                return d >= winStart && d <= clampedEnd
            })

            if (inWindow.length < 3) continue

            const open  = inWindow[0].close
            const close = inWindow[inWindow.length - 1].close
            const ret   = ((close - open) / open) * 100
            const isCurrent  = year === currentYear
            const isComplete = !isCurrent || new Date() > winEnd

            results.push({ year, ret, isCurrent, isComplete })
        }

        if (!results.length) {
            lines.push('Not enough data to compute calendar seasonality for the requested window.')
            return lines.join('\n')
        }

        const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        const windowLabel = month_start === mEnd
            ? `${monthNames[month_start - 1]}${day_start !== 1 || day_end !== 31 ? ` ${day_start}–${day_end}` : ''}`
            : `${monthNames[month_start - 1]}–${monthNames[mEnd - 1]}`

        lines.push(`\nCalendar seasonality — window: ${windowLabel}`)

        const pastResults = results.filter(r => !r.isCurrent)
        for (const r of results) {
            const label = r.isCurrent
                ? `${r.year} (current${r.isComplete ? '' : ', in progress'})`
                : String(r.year)
            lines.push(`  ${label}: ${r.ret >= 0 ? '+' : ''}${r.ret.toFixed(1)}%`)
        }

        if (pastResults.length >= 2) {
            const avgRet   = pastResults.reduce((a, b) => a + b.ret, 0) / pastResults.length
            const positives = pastResults.filter(r => r.ret > 0).length
            const hitRate  = positives / pastResults.length

            lines.push(`Average return (past ${pastResults.length} years): ${avgRet >= 0 ? '+' : ''}${avgRet.toFixed(1)}%`)
            lines.push(`Hit rate: ${Math.round(hitRate * 100)}% positive (${positives}/${pastResults.length} years)`)

            if (hitRate >= 0.75 && avgRet > 1) {
                lines.push(`Seasonality signal: STRONG BULLISH — consistent positive returns in this window.`)
            } else if (hitRate <= 0.25 && avgRet < -1) {
                lines.push(`Seasonality signal: STRONG BEARISH — consistent negative returns in this window.`)
            } else if (hitRate >= 0.6) {
                lines.push(`Seasonality signal: MODERATE BULLISH — tends positive but not decisive.`)
            } else if (hitRate <= 0.4) {
                lines.push(`Seasonality signal: MODERATE BEARISH — tends negative but not decisive.`)
            } else {
                lines.push(`Seasonality signal: MIXED — no clear directional pattern in this window.`)
            }

            const current = results.find(r => r.isCurrent)
            if (current && !current.isComplete) {
                const direction = avgRet > 0 ? 'positive' : 'negative'
                const aligns = (current.ret > 0) === (avgRet > 0)
                lines.push(`Current year vs historical: ${current.ret >= 0 ? '+' : ''}${current.ret.toFixed(1)}% so far — ${aligns ? 'aligns with' : 'diverges from'} the historical ${direction} bias.`)
            }
        }
    }

    return lines.join('\n')
}

// --- Earnings -----------------------------------------------------------------
// Per-ticker earnings snapshot: upcoming date + EPS estimate + last 4 quarterly
// actuals vs estimates. Uses Yahoo's calendarEvents + earnings modules. The
// upcoming date is typically a window (earningsDate[0] → earningsDate[1]).
const EARN_TTL_MS = 6 * 60 * 60 * 1000
const _earnCache = createTtlCache({ ttlMs: EARN_TTL_MS }) // SYMBOL -> text

export async function getEarnings(ticker) {
    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) return 'No ticker provided.'

    const hit = _earnCache.get(sym)
    if (hit) return hit

    let cal, chart
    try {
        const s = await yf.quoteSummary(sym, { modules: ['calendarEvents', 'earnings'] })
        cal   = s?.calendarEvents?.earnings ?? {}
        chart = s?.earnings?.earningsChart   ?? {}
    } catch (err) {
        return `No earnings data for ${sym}: ${err.message}`
    }

    const lines = [`${sym} — earnings:`]

    const dates = cal.earningsDate
    if (Array.isArray(dates) && dates.length) {
        const fmt = dates.map(d => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10))
        lines.push(`Next earnings: ${fmt.join(' – ')}`)
    }

    const epsEst  = cal.earningsAverage
    const epsLow  = cal.earningsLow
    const epsHigh = cal.earningsHigh
    if (epsEst != null) {
        const range = (epsLow != null && epsHigh != null)
            ? ` (range ${Number(epsLow).toFixed(2)} – ${Number(epsHigh).toFixed(2)})`
            : ''
        lines.push(`EPS estimate: ${Number(epsEst).toFixed(2)}${range}`)
    }

    const quarterly = chart.quarterly
    if (Array.isArray(quarterly) && quarterly.length) {
        lines.push('Recent quarters (actual vs estimate):')
        for (const q of quarterly.slice(-4)) {
            const actual = q.actual?.raw   ?? (typeof q.actual   === 'number' ? q.actual   : null)
            const est    = q.estimate?.raw ?? (typeof q.estimate === 'number' ? q.estimate : null)
            const actStr = actual != null ? Number(actual).toFixed(2) : 'n/a'
            const estStr = est    != null ? Number(est).toFixed(2)    : 'n/a'
            const surp   = (actual != null && est != null && est !== 0)
                ? ` (${((actual - est) / Math.abs(est) * 100).toFixed(1)}% surprise)`
                : ''
            lines.push(`  ${q.date ?? '?'}: actual ${actStr} vs est ${estStr}${surp}`)
        }
    }

    const text = lines.join('\n')
    _earnCache.set(sym, text)
    return text
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
