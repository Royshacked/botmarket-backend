// Price ANALYTICS — risk, correlations, price action, cycles — computed over candles from whichever
// source the router picks. LLM-ready strings for the desks' tools (get_risk_metrics, get_price_action,
// get_correlations, get_cycle_analysis) plus the raw vols + correlation read Atlas sizes a book with.
//
// Lifted out of providers/yahoofinance.provider.js (2026-09-16). None of this was Yahoo's: it is
// arithmetic over a candle series, and it sat in a provider by history — with its own FMP-first
// fetch (`_candles`) that bypassed candles.provider, skipped Massive and ignored USE_FMP_CANDLES,
// because a provider cannot import the router without a cycle (candles → massive → yahoo). A
// service can, so the analytics read candles the way every other consumer does. The pure math is
// priceStats.util and cycleAnalysis.service; this module is the fetch + the sentence.

import { getTickerAggregates } from '../providers/candles.provider.js'
import {
    logReturns as _logReturns,
    stdev as _stdev,
    atr as _atr,
    correlationMatrix as _correlationMatrix,
} from './priceStats.util.js'
import {
    findExtrema as _findExtrema,
    cycleStats as _cycleStats,
    tdToCalDays as _tdToCalDays,
    addCalDays as _addCalDays,
    fmtDuration as _fmtDuration,
    fmtDateTimeUTC as _fmtDateTimeUTC,
} from './cycleAnalysis.service.js'

// --- Risk / correlation helpers (computed from daily candles) ---------------

const TRADING_DAYS = 252

// THE source decision is not made here. candles.provider owns it (FMP-first under USE_FMP_CANDLES,
// else Massive → Yahoo); this used to carry a private FMP → Yahoo copy that skipped Massive and
// ignored the flag — the third such copy candleFetch's header describes, and the reason the
// analytics could not live in the provider tier (the provider cannot import the router without a
// cycle). `_deps` is the test seam.
export const _deps = { getTickerAggregates }
const _candles = (sym, opts) => _deps.getTickerAggregates(sym, opts)

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
 * Fetch daily candles once per ticker and derive both annualized volatilities
 * and the correlation matrix in a single pass — one fetch per ticker, not two.
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
