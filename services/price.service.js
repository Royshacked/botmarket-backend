import { getTickerAggregates } from '../providers/massive.provider.js'
import { isCacheFresh, loadCandlesFromFile, saveCandlesToFile } from './util.service.js'

const DEFAULT_RANGE_DAYS = 30
const CANDLE_CACHE_TTL_MS = 60 * 60 * 1000
const CANDLE_SCHEMA = 'ohlcv6'

/** @typedef {[number, number, number, number, number, number]} CandleRow */
/** @typedef {{ timestamp: number, open: number, high: number, low: number, close: number, volume: number }} CandleObject */
/**
 * @typedef {{
 *   timeSpan?: string,
 *   multiplier?: number,
 *   from?: number,
 *   to?: number,
 *   fromSec?: number,
 *   toSec?: number,
 *   format?: 'compact' | 'object',
 *   refresh?: boolean,
 * }} PriceOptions
 */

const OHLCV = { T: 0, O: 1, H: 2, L: 3, C: 4, V: 5 }

const DEFAULT_OPTIONS = {
    timeSpan: 'day',
    multiplier: 1,
}

export const priceService = {
    syncCandles,
    queryCandles,
    getCandles,
    toCompactRow,
}

export const CANDLE_ROW_SCHEMA = CANDLE_SCHEMA
export { OHLCV }

export const PRICE_TOOLS = {
    syncCandles: {
        id: 'price.sync_candles',
        handler: (input) => syncCandles(input.ticker, input),
        description: 'Fetch incremental OHLCV candles, merge into cache, return newly added bars.',
        inputSchema: {
            type: 'object',
            properties: {
                ticker: { type: 'string' },
                timeSpan: { type: 'string' },
                multiplier: { type: 'number' },
                from: { type: 'number', description: 'Unix ms for provider fetch window start' },
                to: { type: 'number', description: 'Unix ms for provider fetch window end' },
                format: { type: 'string', enum: ['compact', 'object'] },
            },
            required: ['ticker'],
        },
    },
    queryCandles: {
        id: 'price.query_candles',
        handler: (input) => queryCandles(input.ticker, input),
        description: 'Read cached candles for a ticker (optional unix-second range filter).',
        inputSchema: {
            type: 'object',
            properties: {
                ticker: { type: 'string' },
                timeSpan: { type: 'string' },
                multiplier: { type: 'number' },
                fromSec: { type: 'number' },
                toSec: { type: 'number' },
                format: { type: 'string', enum: ['compact', 'object'] },
            },
            required: ['ticker'],
        },
    },
    getCandles: {
        id: 'price.get_candles',
        handler: (input) => getCandles(input.ticker, input),
        description:
            'Load cached OHLCV for a ticker or sync from provider when cache is empty, stale, or refresh is true. Use fromSec/toSec/timeSpan/multiplier from price.resolve_candle_opts.',
        inputSchema: {
            type: 'object',
            properties: {
                ticker: { type: 'string' },
                timeSpan: { type: 'string' },
                multiplier: { type: 'number' },
                fromSec: { type: 'number', description: 'Unix seconds (inclusive window start)' },
                toSec: { type: 'number', description: 'Unix seconds (inclusive window end)' },
                refresh: { type: 'boolean' },
                format: { type: 'string', enum: ['compact', 'object'] },
            },
            required: ['ticker'],
        },
    },
}

async function syncCandles(ticker, options = {}) {
    const symbol = _normalizeTicker(ticker)
    const barOpts = _normalizeOptions(options)
    const cache = await _loadEnvelope(symbol, barOpts)
    const existingCandles = cache.candles

    const toMs = barOpts.to ?? Date.now()
    let fromMs = barOpts.from

    const latestTs = _maxCandleTimestamp(existingCandles)
    if (latestTs != null && fromMs == null) {
        const stepSec = _barDurationSeconds(barOpts.timeSpan, barOpts.multiplier)
        fromMs = (latestTs + stepSec) * 1000
    }
    if (fromMs == null) {
        fromMs = toMs - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000
    }

    const fetchOptions = { ...barOpts, from: fromMs, to: toMs }
    let incomingList = []
    try {
        const incoming = await getTickerAggregates(symbol, fetchOptions)
        incomingList = Array.isArray(incoming) ? incoming : []
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return _result(_formatCandles([], options.format), {
            ingested: 0,
            cacheSize: existingCandles.length,
            schema: CANDLE_SCHEMA,
            ticker: symbol,
            timeSpan: barOpts.timeSpan,
            multiplier: barOpts.multiplier,
            reason: 'fetch_failed',
            error: message,
        })
    }

    const { merged, added } = _mergeDeduped(existingCandles, incomingList)
    await _saveEnvelope(symbol, barOpts, merged)

    return _result(_formatCandles(added, options.format), {
        ingested: added.length,
        cacheSize: merged.length,
        schema: CANDLE_SCHEMA,
        ticker: symbol,
        timeSpan: barOpts.timeSpan,
        multiplier: barOpts.multiplier,
        fromMs,
        toMs,
        lastFetchedAt: Date.now(),
    })
}

async function queryCandles(ticker, options = {}) {
    const symbol = _normalizeTicker(ticker)
    const barOpts = _normalizeOptions(options)
    const cache = await _loadEnvelope(symbol, barOpts)
    return _queryFromEnvelope(symbol, barOpts, cache, options)
}

async function getCandles(ticker, opts = {}) {
    const symbol = _normalizeTicker(ticker)
    const barOpts = _normalizeOptions(opts)
    let cache = await _loadEnvelope(symbol, barOpts)

    const shouldFetch =
        opts.refresh === true ||
        cache.candles.length === 0 ||
        !isCacheFresh(cache.lastFetchedAt, CANDLE_CACHE_TTL_MS)

    let syncMeta = {}
    if (shouldFetch) {
        const synced = await syncCandles(ticker, opts)
        syncMeta = synced.meta ?? {}
        cache = await _loadEnvelope(symbol, barOpts)
    }

    const { candles, meta } = _queryFromEnvelope(symbol, barOpts, cache, opts)
    const resultMeta = { ...meta, cached: !shouldFetch }
    if (shouldFetch) {
        resultMeta.ingested = syncMeta.ingested ?? 0
        if (syncMeta.reason) {
            resultMeta.reason = syncMeta.reason
            resultMeta.error = syncMeta.error
        }
    }
    return _result(candles, resultMeta)
}

function _queryFromEnvelope(symbol, barOpts, cache, options = {}) {
    const range = _resolveSecRange(options)
    const filtered = _filterBySecRange(cache.candles, range.fromSec, range.toSec)
    const sorted = [...filtered].sort((a, b) => candleTimestamp(a) - candleTimestamp(b))

    return _result(_formatCandles(sorted, options.format), {
        ticker: symbol,
        timeSpan: barOpts.timeSpan,
        multiplier: barOpts.multiplier,
        fromSec: range.fromSec,
        toSec: range.toSec,
        count: filtered.length,
        schema: CANDLE_SCHEMA,
        lastFetchedAt: cache.lastFetchedAt,
    })
}

async function _loadEnvelope(ticker, barOpts) {
    const loaded = await loadCandlesFromFile(ticker, barOpts)
    return _normalizeEnvelope(loaded.ok ? loaded.data : null)
}

async function _saveEnvelope(ticker, barOpts, candles) {
    const rows = (Array.isArray(candles) ? candles : [])
        .map(toCompactRow)
        .filter(Boolean)

    const envelope = {
        lastFetchedAt: Date.now(),
        schema: CANDLE_SCHEMA,
        candles: rows,
    }
    const saved = await saveCandlesToFile(ticker, barOpts, envelope)
    if (!saved.ok) {
        throw new Error(
            `Failed to save candles for ${ticker}/${barOpts.timeSpan}: ${saved.error?.message}`
        )
    }
    return envelope
}

function _normalizeEnvelope(raw) {
    if (raw == null) {
        return { lastFetchedAt: 0, schema: CANDLE_SCHEMA, candles: [] }
    }
    if (raw && typeof raw === 'object' && Array.isArray(raw.candles)) {
        return {
            lastFetchedAt: Number(raw.lastFetchedAt) || 0,
            schema: raw.schema || CANDLE_SCHEMA,
            candles: raw.candles.map(toCompactRow).filter(Boolean),
        }
    }
    return { lastFetchedAt: 0, schema: CANDLE_SCHEMA, candles: [] }
}

export function toCompactRow(candle) {
    if (Array.isArray(candle)) {
        if (candle.length < 6) return null
        const t = candle[OHLCV.T]
        if (!Number.isFinite(t)) return null
        return [
            t,
            candle[OHLCV.O],
            candle[OHLCV.H],
            candle[OHLCV.L],
            candle[OHLCV.C],
            candle[OHLCV.V],
        ]
    }
    if (candle && typeof candle === 'object' && Number.isFinite(candle.timestamp)) {
        return [
            candle.timestamp,
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            candle.volume,
        ]
    }
    return null
}

function toCandleObject(row) {
    const compact = toCompactRow(row)
    if (!compact) return null
    return {
        timestamp: compact[OHLCV.T],
        open: compact[OHLCV.O],
        high: compact[OHLCV.H],
        low: compact[OHLCV.L],
        close: compact[OHLCV.C],
        volume: compact[OHLCV.V],
    }
}

function candleTimestamp(candle) {
    if (Array.isArray(candle) && Number.isFinite(candle[OHLCV.T])) {
        return candle[OHLCV.T]
    }
    if (candle && typeof candle === 'object' && Number.isFinite(candle.timestamp)) {
        return candle.timestamp
    }
    return NaN
}

function _mergeDeduped(existing = [], incoming = []) {
    const byTs = new Map()
    for (const c of [...existing, ...incoming]) {
        const row = toCompactRow(c)
        if (row) byTs.set(row[OHLCV.T], row)
    }
    const merged = [...byTs.keys()].sort((a, b) => a - b).map((ts) => byTs.get(ts))

    const existingKeys = new Set(
        existing.map(toCompactRow).filter(Boolean).map((r) => r[OHLCV.T])
    )
    const added = incoming
        .map(toCompactRow)
        .filter((r) => r && !existingKeys.has(r[OHLCV.T]))

    return { merged, added }
}

function _barDurationSeconds(timeSpan, multiplier) {
    const m = Math.max(1, Math.trunc(Number(multiplier) || 1))
    switch (timeSpan) {
        case 'minute':
            return m * 60
        case 'hour':
            return m * 3600
        case 'day':
            return m * 86400
        case 'week':
            return m * 7 * 86400
        case 'month':
            return m * 30 * 86400
        case 'quarter':
            return m * 91 * 86400
        case 'year':
            return m * 365 * 86400
        default:
            return m * 60
    }
}

function _maxCandleTimestamp(candles) {
    let max = -Infinity
    for (const c of candles) {
        const t = candleTimestamp(c)
        if (Number.isFinite(t) && t > max) max = t
    }
    return Number.isFinite(max) ? max : null
}

function _filterBySecRange(candles, fromSec, toSec) {
    return candles.filter((c) => {
        const t = candleTimestamp(c)
        return Number.isFinite(t) && t >= fromSec && t <= toSec
    })
}

function _resolveSecRange({ fromSec, toSec } = {}) {
    const nowSec = Math.floor(Date.now() / 1000)
    const defaultFromSec = nowSec - DEFAULT_RANGE_DAYS * 86400
    return {
        fromSec: Number.isFinite(fromSec) ? fromSec : defaultFromSec,
        toSec: Number.isFinite(toSec) ? toSec : nowSec,
    }
}

function _formatCandles(candles, format) {
    if (format === 'object') {
        return candles.map(toCandleObject).filter(Boolean)
    }
    return candles.map(toCompactRow).filter(Boolean)
}

function _normalizeTicker(ticker) {
    if (!ticker || typeof ticker !== 'string') {
        throw new Error('ticker is required')
    }
    return ticker.trim().toUpperCase()
}

/** Provider fetch window (ms): from/to, else fromSec/toSec converted. */
function _resolveFetchWindow(options = {}) {
    const from = Number.isFinite(options.from)
        ? options.from
        : Number.isFinite(options.fromSec)
          ? options.fromSec * 1000
          : undefined
    const to = Number.isFinite(options.to)
        ? options.to
        : Number.isFinite(options.toSec)
          ? options.toSec * 1000
          : undefined
    return { from, to }
}

function _normalizeOptions(options = {}) {
    const { from, to } = _resolveFetchWindow(options)
    return {
        timeSpan: options.timeSpan ?? DEFAULT_OPTIONS.timeSpan,
        multiplier: options.multiplier ?? DEFAULT_OPTIONS.multiplier,
        from,
        to,
    }
}

function _result(candles, meta = {}) {
    return {
        candles: Array.isArray(candles) ? candles : [],
        meta,
    }
}
