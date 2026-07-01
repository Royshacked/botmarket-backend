// Provider-agnostic statistics / TA primitives. These are pure functions of
// plain arrays (closes / candles / returns) — no Yahoo, no fetching, no config.
// Extracted from yahoofinance.provider.js so any price provider can share them.
//
//  - logReturns(closes)          → number[] log returns (skips non-positive)
//  - stdev(xs)                   → sample standard deviation
//  - atr(candles, period)        → Average True Range over last `period` candles
//  - pearson(a, b)               → Pearson correlation coefficient
//  - correlationMatrix(returns)  → symmetric Pearson matrix over return series

/** @typedef {import('./price.service.js').CandleObject} CandleObject */

export function logReturns(closes) {
    const out = []
    for (let i = 1; i < closes.length; i++) {
        if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]))
    }
    return out
}

export function stdev(xs) {
    if (xs.length < 2) return 0
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)
    return Math.sqrt(variance)
}

// Average True Range over the last `period` candles.
export function atr(candles, period = 14) {
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

export function pearson(a, b) {
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

/**
 * Build a symmetric Pearson correlation matrix from an array of return series.
 * `returns[i]` is the return series for symbol i; result[i][j] = pearson(i, j).
 */
export function correlationMatrix(returns) {
    return returns.map((_, i) => returns.map((_, j) => pearson(returns[i], returns[j])))
}
