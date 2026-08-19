import { getTickerAggregates } from '../providers/candles.provider.js'
import { isCacheFresh } from './util.service.js'
import { barDurationSeconds } from './timeframe.service.js'

const DEFAULT_RANGE_DAYS = 30
const CANDLE_CACHE_TTL_MS = 60 * 60 * 1000
const CANDLE_SCHEMA = 'ohlcv6'

/** @typedef {[number, number, number, number, number, number]} CandleRow */
/**
 * Verbose object candle shape shared by the aggregate providers
 * (massive.provider, yahoofinance.provider) and this service.
 * @typedef {{ timestamp: number, open: number, high: number, low: number, close: number, volume: number }} CandleObject
 */
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

/**
 * Test seam for the one external call this module makes. Same shape the other services use — the
 * source decision itself lives in candles.provider, this only names it so a test can stand in for it.
 */
export const _deps = { getTickerAggregates }

/**
 * WHERE A FETCH STARTS — the tail, or the whole requested window. Pure; exported for tests.
 *
 * FETCH ONLY THE TAIL when the cache already reaches back as far as the caller asked. The
 * incremental start (newest bar + one step) is what keeps a monitor tick cheap: intraday callers
 * pass `refresh`, so this runs on EVERY wake, and re-pulling the whole window each time is exactly
 * the self-inflicted quota burn that once had FMP answering 429.
 *
 * BACKFILL ONCE when they asked for more history than the cache holds. Without that clause a
 * widened window would be requested forever and never arrive, because an incremental fetch only
 * ever adds to the NEWEST end — the older bars it needs are behind it and nothing would go and get
 * them. After one full pass the cache covers the range and this goes back to tails.
 *
 * @param {{requestedFromMs?: number, toMs: number, earliestTs: number|null, latestTs: number|null, stepSec: number}} spec
 *   `earliestTs` / `latestTs` are the cache's bounds in SECONDS (the stored candle unit).
 * @returns {number} epoch ms
 */
export function fetchStartMs({ requestedFromMs, toMs, earliestTs, latestTs, stepSec }) {
    const asked = Number.isFinite(requestedFromMs) ? requestedFromMs : null
    const coversStart = asked == null || (earliestTs != null && earliestTs * 1000 <= asked)
    if (latestTs != null && coversStart) return (latestTs + stepSec) * 1000
    if (asked != null) return asked
    return toMs - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000
}

async function syncCandles(ticker, options = {}) {
    const symbol = _normalizeTicker(ticker)
    const barOpts = _normalizeOptions(options)
    const cache = await _loadEnvelope(symbol, barOpts)
    const existingCandles = cache.candles

    const toMs = barOpts.to ?? Date.now()
    const fromMs = fetchStartMs({
        requestedFromMs: barOpts.from,
        toMs,
        earliestTs: _minCandleTimestamp(existingCandles),
        latestTs:   _maxCandleTimestamp(existingCandles),
        stepSec:    barDurationSeconds(barOpts.timeSpan, barOpts.multiplier),
    })

    const fetchOptions = { ...barOpts, from: fromMs, to: toMs }
    let incomingList = []
    try {
        const incoming = await _deps.getTickerAggregates(symbol, fetchOptions)
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

/**
 * THE CANDLE CACHE — in this process, not on the disk.
 *
 * It used to be a JSON file per ticker/timeframe under `data/candles`, and it sat on the monitor's
 * hot path: a blocking existsSync + a read + a JSON.parse before every evaluation, then a
 * pretty-printed write after it. For INTRADAY that bought nothing at all — those callers pass
 * `refresh`, so the fetch happened regardless and the file was pure overhead on both ends.
 *
 * It was also unsafe in two ways that cost real bars. The read-modify-write had no lock, so two
 * loops waking on the same symbol could interleave and the later write would drop what the earlier
 * one had just fetched. And the write was not atomic — no temp-and-rename — so an unlucky restart
 * left truncated JSON, which parses as nothing and silently re-fetches the whole window.
 *
 * Memory is the honest tier for it. `data/` is gitignored and machine-local, so it was never shared
 * or deployed, and the app is deliberately ONE process (docs/architecture/single-instance.md) with
 * other load-bearing module-level Maps already. The whole cost of the change is that a restart
 * re-fetches, once, per symbol and timeframe in use.
 *
 * NOT createTtlCache, though the shape looks identical: that one DELETES a value once it is stale,
 * and a stale envelope is exactly what this needs to keep — it is what `fetchStartMs` reads to fetch
 * only the tail, and what the merge appends onto. Staleness here decides whether to REFRESH, never
 * whether the data is usable. `lastFetchedAt` on the envelope already carries it.
 */
const MAX_CACHED_SERIES = 500
const _envelopes = new Map()   // `${ticker}|${timeSpan}|${multiplier}` → envelope

const _envelopeKey = (ticker, { timeSpan, multiplier }) => `${ticker}|${timeSpan}|${multiplier}`

/** Drop every cached series. Exported for tests — nothing in production clears this. */
export function _resetCandleCache() { _envelopes.clear() }

async function _loadEnvelope(ticker, barOpts) {
    return _normalizeEnvelope(_envelopes.get(_envelopeKey(ticker, barOpts)) ?? null)
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
    const key = _envelopeKey(ticker, barOpts)
    // Re-insert so the key moves to the end: Map keeps insertion order, which makes the eviction
    // below drop the least recently WRITTEN series rather than an arbitrary one.
    _envelopes.delete(key)
    _envelopes.set(key, envelope)
    while (_envelopes.size > MAX_CACHED_SERIES) {
        _envelopes.delete(_envelopes.keys().next().value)
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

function _maxCandleTimestamp(candles) {
    let max = -Infinity
    for (const c of candles) {
        const t = candleTimestamp(c)
        if (Number.isFinite(t) && t > max) max = t
    }
    return Number.isFinite(max) ? max : null
}

function _minCandleTimestamp(candles) {
    let min = Infinity
    for (const c of candles) {
        const t = candleTimestamp(c)
        if (Number.isFinite(t) && t < min) min = t
    }
    return Number.isFinite(min) ? min : null
}

function _filterBySecRange(candles, fromSec, toSec) {
    return candles.filter((c) => {
        const t = candleTimestamp(c)
        return Number.isFinite(t) && t >= fromSec && t <= toSec
    })
}

/**
 * The window a READ returns, in seconds.
 *
 * ONE window, shared with the fetch. It used to accept only `fromSec`/`toSec` while the FETCH
 * (_resolveFetchWindow) accepted `from`/`to` in milliseconds as well — so a caller asking for a
 * year in ms widened what was fetched and stored, and still got back thirty days. The extra bars
 * were written to the cache and could never be read out of it, which is a hard thing to notice:
 * nothing errors, the series is simply short, and a long-lookback indicator quietly reads n/a
 * (indicator.evaluator warns about exactly this for SMA-200).
 *
 * DEFAULT_RANGE_DAYS survives as the FLOOR for a caller that names no window at all.
 */
export function _resolveSecRange(options = {}) {
    const nowSec = Math.floor(Date.now() / 1000)
    const { from, to } = _resolveFetchWindow(options)
    return {
        fromSec: Number.isFinite(from) ? Math.floor(from / 1000) : nowSec - DEFAULT_RANGE_DAYS * 86400,
        toSec:   Number.isFinite(to)   ? Math.floor(to / 1000)   : nowSec,
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
