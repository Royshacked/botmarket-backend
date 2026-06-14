/**
 * Shared price candle specification: normalize LLM/agent partial input and resolve
 * fetch options for priceService.getCandles. Orchestrator and future MCP agents should
 * call resolvePriceCandleOpts before price.get_candles.
 */

import {
    VALID_TIME_SPANS,
    barDurationSeconds,
    barSpecCacheKey,
    isIntradaySpan,
} from './timeframe.service.js'

const SEC_PER_DAY = 86400
const DEFAULT_LLM_BAR_LIMIT = 60
/** Intraday explicit toSec older than this is treated as a bad LLM date and ignored. */
const INTRADAY_STALE_SEC = 7 * SEC_PER_DAY
const FUTURE_SLACK_SEC = 3600

// Re-exported for callers that import these from the candle-spec module.
export { VALID_TIME_SPANS, barSpecCacheKey }

/**
 * @typedef {{
 *   timeSpan: string,
 *   multiplier: number,
 *   fromSec: number | null,
 *   toSec: number | null,
 *   lookbackDays: number | null,
 * }} NormalizedPriceAnalysisSpec
 */

/**
 * @typedef {{
 *   timeSpan: string,
 *   multiplier: number,
 *   fromSec: number,
 *   toSec: number,
 *   barLimit: number,
 * }} ResolvedPriceCandleOpts
 */

/**
 * @param {unknown} raw
 * @returns {NormalizedPriceAnalysisSpec}
 */
export function normalizePriceAnalysisSpec(raw) {
    const input = raw && typeof raw === 'object' ? raw : {}

    const timeSpan = VALID_TIME_SPANS.includes(input.timeSpan)
        ? input.timeSpan
        : 'day'

    const multiplier =
        input.multiplier != null && Number.isFinite(Number(input.multiplier))
            ? _coercePositiveInt(input.multiplier, 15)
            : timeSpan === 'minute'
              ? 15
              : 1

    return {
        timeSpan,
        multiplier,
        fromSec: _coerceOptionalSec(input.fromSec),
        toSec: _coerceOptionalSec(input.toSec),
        lookbackDays: _coerceOptionalPositiveNumber(input.lookbackDays),
    }
}

/**
 * Turn a normalized or partial spec into options for priceService.getCandles.
 * @param {unknown} spec
 * @param {{ userPrompt?: string }} [opts]
 * @returns {ResolvedPriceCandleOpts}
 */
export function resolvePriceCandleOpts(spec, opts = {}) {
    const normalized = normalizePriceAnalysisSpec(spec)
    let { timeSpan, multiplier } = normalized
    const hints = _parsePromptHints(opts.userPrompt)

    const nowSec = Math.floor(Date.now() / 1000)
    let fromSecInput = normalized.fromSec
    let toSecInput = normalized.toSec

    if (hints.intraday && timeSpan === 'minute' && multiplier === 1 && !hints.explicit1m) {
        multiplier = 15
    }

    if (hints.lastFriday && (hints.intraday || isIntradaySpan(timeSpan))) {
        timeSpan = 'minute'
        multiplier = hints.explicit15m ? 15 : hints.explicit5m ? 5 : 15
        const session = lastFridayUsRthRange()
        fromSecInput = session.fromSec
        toSecInput = session.toSec
    }

    if (isIntradaySpan(timeSpan) && toSecInput != null && toSecInput < nowSec - INTRADAY_STALE_SEC) {
        fromSecInput = null
        toSecInput = null
    }

    let toSec = toSecInput ?? nowSec
    if (toSec > nowSec + FUTURE_SLACK_SEC) {
        toSec = nowSec
    }

    let fromSec
    if (fromSecInput != null) {
        fromSec = fromSecInput
    } else if (normalized.lookbackDays != null) {
        fromSec = toSec - normalized.lookbackDays * SEC_PER_DAY
    } else {
        fromSec = toSec - _presetLookbackDays(timeSpan, multiplier) * SEC_PER_DAY
    }

    if (fromSec > toSec) {
        fromSec = toSec - _presetLookbackDays(timeSpan, multiplier) * SEC_PER_DAY
    }

    const barLimit = _deriveBarLimit({ timeSpan, multiplier, fromSec, toSec })

    return { timeSpan, multiplier, fromSec, toSec, barLimit }
}

/**
 * US/Eastern regular session (9:30–16:00) for the most recent Friday before today.
 * @param {Date} [now]
 * @returns {{ fromSec: number, toSec: number }}
 */
export function lastFridayUsRthRange(now = new Date()) {
    const { y, m, d } = _lastFridayDateInNewYork(now)
    return {
        fromSec: _nyLocalToUtcSec(y, m, d, 9, 30),
        toSec: _nyLocalToUtcSec(y, m, d, 16, 0),
    }
}


/** @param {string | undefined} userPrompt */
function _parsePromptHints(userPrompt) {
    if (!userPrompt || typeof userPrompt !== 'string') {
        return {
            intraday: false,
            lastFriday: false,
            explicit1m: false,
            explicit5m: false,
            explicit15m: false,
        }
    }
    const p = userPrompt.toLowerCase()
    return {
        intraday: /\bintraday\b/.test(p),
        lastFriday: /\blast\s+friday\b/.test(p) || /\bon\s+friday\b/.test(p),
        explicit1m: /\b1\s*(-)?\s*m(in(ute)?)?\b/.test(p),
        explicit5m: /\b5\s*(-)?\s*m(in(ute)?)?\b/.test(p),
        explicit15m: /\b15\s*(-)?\s*m(in(ute)?)?\b/.test(p),
    }
}

/** @param {Date} now */
function _lastFridayDateInNewYork(now) {
    let probe = new Date(now.getTime())
    if (_nyDateParts(probe).weekday === 5) {
        probe = new Date(probe.getTime() - 7 * SEC_PER_DAY * 1000)
    }
    for (let i = 0; i < 14; i++) {
        const parts = _nyDateParts(probe)
        if (parts.weekday === 5) {
            return { y: parts.y, m: parts.m, d: parts.d }
        }
        probe = new Date(probe.getTime() - SEC_PER_DAY * 1000)
    }
    const fallback = _nyDateParts(new Date(now.getTime() - 3 * SEC_PER_DAY * 1000))
    return { y: fallback.y, m: fallback.m, d: fallback.d }
}

/** @param {Date} date */
function _nyDateParts(date) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    })
    const map = Object.fromEntries(
        fmt.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
    )
    const weekdayShort = map.weekday?.slice(0, 3) ?? 'Sun'
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    return {
        y: parseInt(map.year, 10),
        m: parseInt(map.month, 10),
        d: parseInt(map.day, 10),
        h: parseInt(map.hour, 10),
        min: parseInt(map.minute, 10),
        weekday: weekdayMap[weekdayShort] ?? 0,
    }
}

/** @param {number} y @param {number} m @param {number} d @param {number} hour @param {number} minute */
function _nyLocalToUtcSec(y, m, d, hour, minute) {
    let t = Date.UTC(y, m - 1, d, hour + 5, minute, 0)
    for (let i = 0; i < 48; i++) {
        const p = _nyDateParts(new Date(t))
        if (p.y === y && p.m === m && p.d === d && p.h === hour && p.min === minute) {
            return Math.floor(t / 1000)
        }
        t += ((hour - p.h) * 60 + (minute - p.min)) * 60 * 1000
    }
    return Math.floor(Date.UTC(y, m - 1, d, hour + 4, minute, 0) / 1000)
}

function _presetLookbackDays(timeSpan, multiplier) {
    const m = _coercePositiveInt(multiplier, 1)
    if (timeSpan === 'minute') {
        if (m === 15) return 5
        if (m === 5) return 3
        return 5
    }
    if (timeSpan === 'hour') return 21
    if (timeSpan === 'day') return 30
    if (timeSpan === 'week') return 730
    return 30
}

function _deriveBarLimit({ timeSpan, multiplier, fromSec, toSec }) {
    const stepSec = barDurationSeconds(timeSpan, multiplier)
    const spanSec = Math.max(0, toSec - fromSec)
    const implied = Math.max(1, Math.floor(spanSec / stepSec) + 1)
    return Math.min(DEFAULT_LLM_BAR_LIMIT, implied)
}

function _coercePositiveInt(value, fallback) {
    const n = Math.trunc(Number(value))
    return Number.isFinite(n) && n > 0 ? n : fallback
}

function _coerceOptionalSec(value) {
    const n = Number(value)
    return Number.isFinite(n) ? Math.trunc(n) : null
}

function _coerceOptionalPositiveNumber(value) {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : null
}
