// Provider-agnostic cycle / seasonality primitives. Pure functions over plain
// arrays and dates — no Yahoo, no fetching. Extracted from
// yahoofinance.provider.js; getCycleAnalysis() stays in the provider because it
// fetches candles, but the extrema/cycle/calendar math lives here.
//
//  - findExtrema(closes, lookback) → { peaks: idx[], troughs: idx[] }
//  - cycleStats(indices)           → { mean, std, consistency, count } | null
//  - tdToCalDays(td)               → trading days → approx calendar days
//  - addCalDays(date, days)        → ISO yyyy-mm-dd `days` after `date`

export function findExtrema(closes, lookback = 5) {
    const peaks = [], troughs = []
    for (let i = lookback; i < closes.length - lookback; i++) {
        let isPeak = true, isTrough = true
        for (let j = i - lookback; j <= i + lookback; j++) {
            if (j === i) continue
            if (closes[j] >= closes[i]) isPeak = false
            if (closes[j] <= closes[i]) isTrough = false
        }
        if (isPeak)   peaks.push(i)
        if (isTrough) troughs.push(i)
    }
    return { peaks, troughs }
}

export function cycleStats(indices) {
    if (indices.length < 3) return null
    const intervals = []
    for (let i = 1; i < indices.length; i++) intervals.push(indices[i] - indices[i - 1])
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length
    const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length
    const std = Math.sqrt(variance)
    const consistency = intervals.filter(d => Math.abs(d - mean) <= mean * 0.35).length / intervals.length
    return { mean: Math.round(mean), std: Math.round(std), consistency, count: intervals.length }
}

// Trading days → approximate calendar days (×1.4)
export function tdToCalDays(td) { return Math.round(td * 1.4) }

export function addCalDays(date, days) {
    const d = new Date(date)
    d.setDate(d.getDate() + days)
    return d.toISOString().slice(0, 10)
}
