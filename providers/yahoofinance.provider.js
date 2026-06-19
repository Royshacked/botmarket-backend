import YahooFinance from 'yahoo-finance2'

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })

/**
 * Get a real-time quote for a ticker.
 * Returns a plain string ready to be fed to the LLM as a tool result.
 */
export async function getCompanyName(ticker) {
    try {
        const q = await yf.quote(ticker.toUpperCase())
        return q?.shortName || q?.longName || ticker
    } catch {
        return ticker
    }
}

export async function getQuote(ticker) {
    const q = await yf.quote(ticker.toUpperCase())
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
    const q = await yf.quote(ticker.toUpperCase())
    return { symbol: q.symbol, price: q.regularMarketPrice ?? null }
}

/**
 * Batch quotes for several tickers in one call. Returns an LLM-ready string
 * table so the agent doesn't have to fetch prices one ticker at a time.
 */
export async function getQuotes(tickers = []) {
    const symbols = [...new Set(tickers.map(t => String(t).toUpperCase()))].filter(Boolean)
    if (!symbols.length) return 'No tickers provided.'
    const results = await Promise.allSettled(symbols.map(s => yf.quote(s)))
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
 * Pairwise Pearson correlation of daily returns across tickers, as an
 * LLM-ready matrix string. Makes "diversified" checkable instead of guessed.
 */
export async function getCorrelations(tickers = []) {
    const symbols = [...new Set(tickers.map(t => String(t).toUpperCase()))].filter(Boolean)
    if (symbols.length < 2) return 'Provide at least two tickers to compute correlations.'

    const series = await Promise.all(symbols.map(async sym => {
        const candles = await _dailyCandles(sym, 365)
        const byDay = new Map(candles.map(c => [c.timestamp, c.close]))
        return { sym, byDay }
    }))

    // Align on the set of timestamps present for every ticker.
    const common = series.reduce((acc, s) => acc.filter(ts => s.byDay.has(ts)), [...series[0].byDay.keys()])
    if (common.length < 20) return 'Not enough overlapping price history to compute correlations.'
    common.sort((a, b) => a - b)

    const returns = series.map(s => _logReturns(common.map(ts => s.byDay.get(ts))))

    const corr = (a, b) => {
        const n = Math.min(a.length, b.length)
        const ma = a.reduce((x, y) => x + y, 0) / n
        const mb = b.reduce((x, y) => x + y, 0) / n
        let num = 0, da = 0, db = 0
        for (let i = 0; i < n; i++) {
            const x = a[i] - ma, y = b[i] - mb
            num += x * y; da += x * x; db += y * y
        }
        return da && db ? num / Math.sqrt(da * db) : 0
    }

    const pad = s => String(s).padStart(7)
    const header = '       ' + symbols.map(pad).join('')
    const rows = symbols.map((sym, i) =>
        pad(sym) + symbols.map((_, j) => pad(corr(returns[i], returns[j]).toFixed(2))).join('')
    )
    return ['Correlation matrix (1y daily returns):', header, ...rows].join('\n')
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
