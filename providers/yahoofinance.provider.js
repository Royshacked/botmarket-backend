import YahooFinance from 'yahoo-finance2'

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })

// Short-TTL quote cache. A single agent turn can price the same ticker several
// times (get_quote, get_quotes, get_risk_metrics, and server-side sizing all
// hit yf.quote); within ~30s a price is effectively unchanged, so dedupe.
const _quoteCache = new Map() // SYMBOL -> { at: epochMs, data }
const QUOTE_TTL_MS  = 30_000
const QUOTE_CACHE_MAX = 500

async function _quote(ticker) {
    const symbol = String(ticker).toUpperCase()
    const hit = _quoteCache.get(symbol)
    if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.data
    const data = await yf.quote(symbol)
    if (_quoteCache.size >= QUOTE_CACHE_MAX) _quoteCache.clear()
    _quoteCache.set(symbol, { at: Date.now(), data })
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

// Fetch ~`days` calendar days of daily OHLC for a ticker.
async function _dailyCandles(ticker, days = 365) {
    const from = Date.now() - days * 24 * 60 * 60 * 1000
    return getTickerAggregates(ticker, { timeSpan: 'day', multiplier: 1, from, to: Date.now() })
}

function _logReturns(closes) {
    const out = []
    for (let i = 1; i < closes.length; i++) {
        if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]))
    }
    return out
}

function _stdev(xs) {
    if (xs.length < 2) return 0
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)
    return Math.sqrt(variance)
}

// Average True Range over the last `period` candles.
function _atr(candles, period = 14) {
    if (candles.length < 2) return null
    const trs = []
    for (let i = 1; i < candles.length; i++) {
        const { high, low } = candles[i]
        const prevClose = candles[i - 1].close
        trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
    }
    const slice = trs.slice(-period)
    return slice.reduce((a, b) => a + b, 0) / slice.length
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

function _pearson(a, b) {
    const n  = Math.min(a.length, b.length)
    const ma = a.reduce((x, y) => x + y, 0) / n
    const mb = b.reduce((x, y) => x + y, 0) / n
    let num = 0, da = 0, db = 0
    for (let i = 0; i < n; i++) {
        const x = a[i] - ma, y = b[i] - mb
        num += x * y; da += x * x; db += y * y
    }
    return da && db ? num / Math.sqrt(da * db) : 0
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
    const matrix  = symbols.map((_, i) => symbols.map((_, j) => _pearson(returns[i], returns[j])))
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
            const matrix  = unique.map((_, i) => unique.map((_, j) => _pearson(returns[i], returns[j])))
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

// --- Earnings -----------------------------------------------------------------
// Per-ticker earnings snapshot: upcoming date + EPS estimate + last 4 quarterly
// actuals vs estimates. Uses Yahoo's calendarEvents + earnings modules. The
// upcoming date is typically a window (earningsDate[0] → earningsDate[1]).
const _earnCache = new Map() // SYMBOL -> { at, text }
const EARN_TTL_MS = 6 * 60 * 60 * 1000

export async function getEarnings(ticker) {
    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) return 'No ticker provided.'

    const hit = _earnCache.get(sym)
    if (hit && Date.now() - hit.at < EARN_TTL_MS) return hit.text

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
    if (_earnCache.size > 500) _earnCache.clear()
    _earnCache.set(sym, { at: Date.now(), text })
    return text
}

// --- Short interest -----------------------------------------------------------
// Short interest is FINRA data: reported bi-monthly with a ~2-week lag, so it is
// inherently stale. We surface the `dateShortInterest` as-of prominently so the
// agent never treats it as a live read. Equities/ADRs only — ETFs, crypto, FX
// and futures have no short-interest figure.
const _siCache = new Map() // SYMBOL -> { at, text }
const SI_TTL_MS = 12 * 60 * 60 * 1000

export async function getShortInterest(ticker) {
    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) return 'No ticker provided.'

    const hit = _siCache.get(sym)
    if (hit && Date.now() - hit.at < SI_TTL_MS) return hit.text

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
    const fmtShares = v => {
        const n = Number(v)
        if (!Number.isFinite(n)) return null
        if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
        if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
        return `${n.toFixed(0)}`
    }
    const asOf = stats.dateShortInterest
        ? (stats.dateShortInterest instanceof Date ? stats.dateShortInterest : new Date(stats.dateShortInterest)).toISOString().slice(0, 10)
        : 'unknown'

    const text = [
        `${sym}${price.shortName ? ` (${price.shortName})` : ''} — short interest`,
        pctFloat   ? `Short % of float: ${pctFloat}` : null,
        daysCover  ? `Days to cover (short ratio): ${daysCover}` : null,
        sharesShort != null ? `Shares short: ${fmtShares(sharesShort)}` : null,
        moM ? `Change: ${moM}` : null,
        `As of: ${asOf} (FINRA settlement date — reported bi-monthly with a ~2-week lag; treat as background, not a live read).`,
    ].filter(Boolean).join('\n')

    if (_siCache.size > 500) _siCache.clear()
    _siCache.set(sym, { at: Date.now(), text })
    return text
}

// --- Options context ----------------------------------------------------------
// Nearest-expiry options snapshot: put/call ratio (by open interest AND volume),
// at-the-money implied volatility, and the available expiries. Quotes are
// 15-min delayed on the free feed. Equities/ETFs with listed options only.
const _optCache = new Map() // SYMBOL -> { at, text }
const OPT_TTL_MS = 60 * 60 * 1000

export async function getOptionsContext(ticker) {
    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) return 'No ticker provided.'

    const hit = _optCache.get(sym)
    if (hit && Date.now() - hit.at < OPT_TTL_MS) return hit.text

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

    if (_optCache.size > 500) _optCache.clear()
    _optCache.set(sym, { at: Date.now(), text })
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
