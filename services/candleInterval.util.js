// Chart interval spellings → the { timeSpan, multiplier } bar spec the candle providers
// speak (see providers/candles.provider.js / fmp.price.provider.js). One source of truth for
// every spelling the frontend chart may send: the app words ('1min','5min','1hr','day'…),
// the TradingView codes the old embed used ('1','5','15','30','D','W','M'), and the legacy
// 'daily'/'weekly'/'monthly'. Pure + dependency-free so it can be unit-tested in isolation.

// key (already lowercased/trimmed) -> [timeSpan, multiplier]
const INTERVAL_MAP = {
    // minutes
    '1m': ['minute', 1], '1min': ['minute', 1],  '1': ['minute', 1],
    '5m': ['minute', 5], '5min': ['minute', 5],  '5': ['minute', 5],
    '15m': ['minute', 15], '15min': ['minute', 15], '15': ['minute', 15],
    '30m': ['minute', 30], '30min': ['minute', 30], '30': ['minute', 30],
    // hours
    '1h': ['hour', 1], '1hr': ['hour', 1], '1hour': ['hour', 1], '60': ['hour', 1], 'hour': ['hour', 1],
    '2h': ['hour', 2], '2hr': ['hour', 2], '2hour': ['hour', 2], '120': ['hour', 2],
    '4h': ['hour', 4], '4hr': ['hour', 4], '4hour': ['hour', 4], '240': ['hour', 4],
    // day / week / month
    'day': ['day', 1], 'daily': ['day', 1], 'd': ['day', 1], '1d': ['day', 1], '1day': ['day', 1],
    'week': ['week', 1], 'weekly': ['week', 1], 'w': ['week', 1], '1w': ['week', 1],
    'month': ['month', 1], 'monthly': ['month', 1], 'm': ['month', 1], '1mo': ['month', 1],
}

/**
 * Normalise a chart interval spelling to `{ timeSpan, multiplier }`, or null when the spelling
 * is unknown (caller answers 400). Pure. Note the TradingView-code overlap: 'M' means MONTH
 * (not minute) and 'D' means DAY, matching the old embed's TV_INTERVAL map.
 *
 * @param {string} interval
 * @returns {{ timeSpan: 'minute'|'hour'|'day'|'week'|'month', multiplier: number } | null}
 */
export function parseChartInterval(interval) {
    if (typeof interval !== 'string') return null
    const hit = INTERVAL_MAP[interval.trim().toLowerCase()]
    if (!hit) return null
    return { timeSpan: hit[0], multiplier: hit[1] }
}

/**
 * Aggregate ascending OHLCV rows into fixed-size groups (1hr bars → 2hr bars). Groups align to END
 * on the newest bar, so an oldest partial group is dropped; `groupSize <= 1` is a passthrough.
 * Pure. THE one aggregate — fmp.price (a provider that cannot import the tools layer) and
 * marketData.tools (the agents' get_candles) each carried a copy, one documented as a "mirror" of
 * the other, which is the shape duplication takes just before it drifts.
 *
 * @param {Array<{timestamp:number,open:number,high:number,low:number,close:number,volume?:number}>} rows
 * @param {number} groupSize
 */
export function aggregateCandles(rows, groupSize) {
    if (!Array.isArray(rows)) return []
    if (rows.length === 0 || !(groupSize > 1)) return rows
    const rem     = rows.length % groupSize
    const aligned = rem ? rows.slice(rem) : rows
    const out = []
    for (let i = 0; i < aligned.length; i += groupSize) {
        const grp = aligned.slice(i, i + groupSize)
        out.push({
            timestamp: grp[0].timestamp,
            open:      grp[0].open,
            high:      Math.max(...grp.map(c => c.high)),
            low:       Math.min(...grp.map(c => c.low)),
            close:     grp[grp.length - 1].close,
            volume:    grp.reduce((s, c) => s + (c.volume || 0), 0),
        })
    }
    return out
}

/**
 * Default history lookback (in days) for a bar spec when the caller gives no from/to — sized to
 * yield a useful, bounded number of bars per timeframe (finer bars → shorter window). Pure.
 *
 * @param {string} timeSpan
 * @param {number} multiplier
 * @returns {number} days
 */
export function defaultLookbackDays(timeSpan, multiplier = 1) {
    if (timeSpan === 'minute') {
        if (multiplier <= 1) return 3
        if (multiplier <= 5) return 10
        if (multiplier <= 15) return 25
        return 40                              // 30min
    }
    if (timeSpan === 'hour') {
        if (multiplier <= 1) return 60
        if (multiplier <= 2) return 90
        return 150                             // 4h
    }
    if (timeSpan === 'day')   return 730       // ~2y
    if (timeSpan === 'week')  return 365 * 7   // ~7y
    return 365 * 20                            // month → ~20y
}
