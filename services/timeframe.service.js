/**
 * Single source of truth for timeframe handling.
 *
 * Two representations live in the codebase and this module owns the mapping
 * between them:
 *
 *   - Timeframe string:  "1min" | "5min" | "15min" | "30min" | "1hr" | "2hr" |
 *                        "4hr" | "day" | "week" | "month"
 *     Spoken by the trade agent, the monitor, and stored on idea documents.
 *     Legacy forms still accepted on read: "minutes" | "hours" | "daily" |
 *     "weekly" | "monthly".
 *
 *   - Bar spec:          { timeSpan: 'minute'|'hour'|'day'|'week'|'month'|…,
 *                          multiplier: number }
 *     Spoken by the price service and the data providers (Massive, Yahoo).
 *
 * `parseTimeframe` is the bridge from string → bar spec; `barDurationSeconds`
 * computes bar width from a bar spec.
 */

const SEC = { MIN: 60, HOUR: 3600, DAY: 86400 }

/** Canonical timeframe strings the agent/monitor speak. */
export const VALID_TIMEFRAMES = new Set([
    '1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month',
])

/** timeSpan values the data providers understand. */
export const VALID_TIME_SPANS = ['minute', 'hour', 'day', 'week', 'month']

const _TF_REMAP = [
    // minute variants: "15m", "15 min", "15-minutes"
    [/^(\d+)\s*[-\s]?m(?:in(?:utes?)?)?$/i, (_, n) => `${n}min`],
    // hour variants: "4h", "4 hr", "4-hours"
    [/^(\d+)\s*[-\s]?h(?:r|rs|our|ours)?$/i, (_, n) => `${n}hr`],
    // named
    [/^daily$/i,   () => 'day'],
    [/^weekly$/i,  () => 'week'],
    [/^monthly$/i, () => 'month'],
]

/**
 * Normalise a free-form timeframe string ("15m", "4 hours", "daily") into its
 * canonical form ("15min", "4hr", "day"). Returns null for empty input; keeps
 * unrecognised strings as-is (better than silently losing them).
 * @param {unknown} tf
 * @returns {string | null}
 */
export function normalizeTimeframe(tf) {
    if (!tf || typeof tf !== 'string') return null
    const s = tf.trim()
    if (VALID_TIMEFRAMES.has(s)) return s
    for (const [re, fn] of _TF_REMAP) {
        const m = s.match(re)
        if (m) return fn(...m)
    }
    return s
}

/**
 * Parse a timeframe string into provider bar-spec options. Accepts canonical
 * ("5min", "4hr", "day") and legacy ("minutes", "daily") forms.
 * Falsy input → daily; unrecognised non-empty string → null (caller decides
 * the fallback and any logging).
 * @param {string | null | undefined} tf
 * @returns {{ timeSpan: string, multiplier: number } | null}
 */
export function parseTimeframe(tf) {
    if (!tf) return { timeSpan: 'day', multiplier: 1 }

    const minMatch = tf.match(/^(\d+)min$/)
    if (minMatch) return { timeSpan: 'minute', multiplier: parseInt(minMatch[1], 10) }

    const hrMatch = tf.match(/^(\d+)hr$/)
    if (hrMatch) return { timeSpan: 'hour', multiplier: parseInt(hrMatch[1], 10) }

    if (tf === 'day')   return { timeSpan: 'day',   multiplier: 1 }
    if (tf === 'week')  return { timeSpan: 'week',  multiplier: 1 }
    if (tf === 'month') return { timeSpan: 'month', multiplier: 1 }

    // Legacy format support
    if (tf === 'minutes') return { timeSpan: 'minute', multiplier: 5 }
    if (tf === 'hours')   return { timeSpan: 'hour',   multiplier: 1 }
    if (tf === 'daily')   return { timeSpan: 'day',    multiplier: 1 }
    if (tf === 'weekly')  return { timeSpan: 'week',   multiplier: 1 }
    if (tf === 'monthly') return { timeSpan: 'month',  multiplier: 1 }

    return null
}

/** Intraday timeframe string (sub-daily) — no new bars while the exchange is closed. */
export function isIntradayTimeframe(tf) {
    return /min$|hr$/.test(tf ?? '')
}

/** Intraday bar spec (sub-daily). */
export function isIntradaySpan(timeSpan) {
    return timeSpan === 'minute' || timeSpan === 'hour'
}

/**
 * Minimum re-check gap (ms) for a timeframe string.
 * Sub-hour bars: gap = bar width. day/week/month: 4h / 24h / 24h
 * (check a few times per bar). Unknown → 4h fallback.
 * @param {string} tf
 * @returns {number} milliseconds
 */
export function getCheckGap(tf) {
    if (!tf) return 4 * SEC.HOUR * 1000

    const minMatch = tf.match(/^(\d+)min$/)
    if (minMatch) return parseInt(minMatch[1], 10) * SEC.MIN * 1000

    const hrMatch = tf.match(/^(\d+)hr$/)
    if (hrMatch) return parseInt(hrMatch[1], 10) * SEC.HOUR * 1000

    if (tf === 'day')   return  4 * SEC.HOUR * 1000
    if (tf === 'week')  return 24 * SEC.HOUR * 1000
    if (tf === 'month') return 24 * SEC.HOUR * 1000

    // Legacy format support
    if (tf === 'minutes') return  5 * SEC.MIN * 1000
    if (tf === 'hours')   return 60 * SEC.MIN * 1000
    if (tf === 'daily')   return  4 * SEC.HOUR * 1000
    if (tf === 'weekly')  return 24 * SEC.HOUR * 1000
    if (tf === 'monthly') return 24 * SEC.HOUR * 1000

    return 4 * SEC.HOUR * 1000
}

/**
 * Duration of one bar in seconds, from a provider bar spec.
 * @param {string} timeSpan
 * @param {number} multiplier
 * @returns {number} seconds
 */
export function barDurationSeconds(timeSpan, multiplier) {
    const m = Math.max(1, Math.trunc(Number(multiplier) || 1))
    switch (timeSpan) {
        case 'minute':  return m * SEC.MIN
        case 'hour':    return m * SEC.HOUR
        case 'day':     return m * SEC.DAY
        case 'week':    return m * 7 * SEC.DAY
        case 'month':   return m * 30 * SEC.DAY
        case 'quarter': return m * 91 * SEC.DAY
        case 'year':    return m * 365 * SEC.DAY
        default:        return m * SEC.MIN
    }
}

/**
 * Cache key segment for per-bar stores (e.g. 15m, 1d, 1w).
 * @param {{ timeSpan: string, multiplier: number }} barSpec
 * @returns {string}
 */
export function barSpecCacheKey({ timeSpan, multiplier }) {
    const span = VALID_TIME_SPANS.includes(timeSpan) ? timeSpan : 'day'
    const m = Math.max(1, Math.trunc(Number(multiplier) || 1))
    const suffix = { minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo' }[span] ?? 'd'
    return `${m}${suffix}`
}
