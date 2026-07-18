// Financial Modeling Prep (FMP) real-time price provider.
//
// Companion to fmp.provider.js (fundamentals/earnings) — this one is live pricing:
// the `/stable/quote` endpoint returns a real-time last price plus the day's high/low
// in a single call, which is exactly what the paper engine needs to mark P&L and detect
// touch fills. Replaces the delayed/unstable Yahoo fast-quote (see reference_fmp_pricing).
//
// Coverage on the current key: equities, ETFs, crypto (…USD), forex (…USD). Futures and
// index CFDs are unreliable — callers keep a candle fallback for those. No batch endpoint
// on this tier, so multi-symbol callers loop single quotes.

import { logger }         from '../services/logger.service.js'
import { createTtlCache } from '../services/ttlCache.util.js'
import { getJson }        from '../services/http.util.js'

const LOG     = '[fmp.price]'
const BASE    = 'https://financialmodelingprep.com/stable'
const API_KEY = process.env.FMP_API_KEY

// Short TTL — quotes must stay fresh for touch-fill detection, but this collapses the
// overlapping mark/fill/equity callers to ~one real fetch per symbol per window.
const QUOTE_TTL_MS = Number(process.env.FMP_QUOTE_TTL_MS) || 3_000
const _quoteCache  = createTtlCache({ ttlMs: QUOTE_TTL_MS, max: 500 }) // SYMBOL -> { v: quote|null }

/**
 * Normalise an FMP `/quote` row into `{ price, dayHigh, dayLow, name }` (numbers, h/l
 * default to price for degenerate rows). Returns null when there is no usable price.
 * Pure — exported for unit testing.
 */
export function normalizeFmpQuote(row) {
    if (!row || typeof row !== 'object') return null
    const price = Number(row.price)
    if (!Number.isFinite(price) || price <= 0) return null
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : null)
    const h = Number(row.dayHigh)
    const l = Number(row.dayLow)
    return {
        symbol:  typeof row.symbol === 'string' ? row.symbol : null,
        name:    typeof row.name === 'string' ? row.name : null,
        price,
        dayHigh: Number.isFinite(h) && h > 0 ? h : price,
        dayLow:  Number.isFinite(l) && l > 0 ? l : price,
        open:          num(row.open),
        previousClose: num(row.previousClose),
        changePercent: num(row.changePercentage),
        tsSec:         num(row.timestamp),   // epoch SECONDS
    }
}

/**
 * Adapt a normalised FMP quote to the yahoo-finance `yf.quote` field names, so the Yahoo
 * provider's quote functions read FMP data unchanged. Pure — exported for testing.
 */
export function toYfQuote(q) {
    if (!q) return null
    return {
        symbol:                      q.symbol,
        shortName:                   q.name,
        regularMarketPrice:          q.price,
        regularMarketOpen:           q.open,
        regularMarketDayHigh:        q.dayHigh,
        regularMarketDayLow:         q.dayLow,
        regularMarketPreviousClose:  q.previousClose,
        regularMarketChangePercent:  q.changePercent,
        regularMarketTime:           q.tsSec,   // epoch seconds (yahoo convention)
    }
}

/** yf.quote-compatible real-time quote from FMP, or null when FMP can't price the symbol. */
export async function getFmpQuoteYf(symbol) {
    return toYfQuote(await getFmpQuoteFull(symbol))
}

/**
 * Real-time quote for a symbol as `{ price, dayHigh, dayLow, name }`, or null when FMP
 * can't price it (uncovered symbol → empty array). Cached ~3s. Throws only on a transient
 * network/provider error so the caller can fall back rather than cache a miss.
 */
export async function getFmpQuoteFull(symbol) {
    const key = String(symbol || '').toUpperCase().trim()
    if (!key) return null

    const cached = _quoteCache.get(key)
    if (cached) return cached.v   // wrapper distinguishes "cached null" from "not cached"

    if (!API_KEY) throw new Error('FMP_API_KEY is not set')

    const arr = await getJson(`${BASE}/quote?symbol=${encodeURIComponent(key)}&apikey=${API_KEY}`, { label: `FMP /quote ${key}` })
    const quote = normalizeFmpQuote(Array.isArray(arr) ? arr[0] : arr)
    _quoteCache.set(key, { v: quote })   // cache null too (uncovered) — short TTL, avoids re-hitting
    if (quote == null) logger.info(LOG, `no FMP price for ${key} (uncovered on this plan)`)
    return quote
}

/** Real-time last price for a symbol, or null. Convenience over getFmpQuoteFull. */
export async function getFmpQuote(symbol) {
    return (await getFmpQuoteFull(symbol))?.price ?? null
}

// ─── Candles ──────────────────────────────────────────────────────────────────
// FMP intraday (`/historical-chart/{interval}`) dates are US/Eastern wall-clock strings;
// EOD (`/historical-price-eod/full`) dates are calendar days. The rest of the system speaks
// UTC epoch SECONDS (both Massive and Yahoo emit `q.date.getTime()/1000`), so every FMP row
// must be converted the same way — a wrong offset shifts every intraday bar and would make
// the monitor misfire. See reference_fmp_pricing / the Stage-2 plan.

/** ET America/New_York offset (ms) from UTC at an instant — negative west of UTC. */
function _etOffsetMs(instant) {
    const asEt  = new Date(new Date(instant).toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const asUtc = new Date(new Date(instant).toLocaleString('en-US', { timeZone: 'UTC' }))
    return asEt.getTime() - asUtc.getTime()
}

/**
 * Parse an FMP date into UTC epoch seconds. Pure — exported for testing.
 *   "YYYY-MM-DD HH:mm:ss" → an ET wall-clock instant → UTC epoch (intraday bars).
 *   "YYYY-MM-DD"          → ET MIDNIGHT of that market day → UTC epoch (EOD bars).
 * Both resolve against ET so daily bars land on the SAME instant Massive uses (04:00Z EDT /
 * 05:00Z EST) — verified by the Stage-2 parity diff (intraday matched to the second; daily
 * had a clean −4h offset that this ET convention closes). Returns null for unparseable input.
 */
export function fmpDateToEpochSec(dateStr) {
    if (typeof dateStr !== 'string') return null
    const m = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/)
    if (!m) return null
    const [, y, mo, d, hh, mi, ss] = m
    // Reject impossible components — Date.UTC silently rolls over (month 13 → next year), which
    // would yield a plausible-but-wrong epoch and corrupt the monitor. A bad row is dropped instead.
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null
    if (hh != null && (+hh > 23 || +mi > 59 || +(ss ?? 0) > 59)) return null
    // Interpret the components as ET wall-clock (date-only → 00:00 ET), then correct by the ET
    // offset at that instant to get true UTC (UTC = ET_wallclock − offset; offset is negative
    // west of UTC). date-only → ET midnight matches Massive's daily-bar convention.
    const asIfUtc = Date.UTC(+y, +mo - 1, +d, +(hh ?? 0), +(mi ?? 0), +(ss ?? 0))
    return Math.floor((asIfUtc - _etOffsetMs(asIfUtc)) / 1000)
}

/**
 * Aggregate ascending OHLCV rows into fixed-size groups (e.g. 1hr → 2hr). Groups align to
 * END on the newest bar; an oldest partial group is dropped. Pure — mirrors
 * marketData.tools.aggregateCandles (inlined to keep this provider dependency-free /
 * cycle-proof). Exported for testing.
 */
export function aggregateOhlc(rows, groupSize) {
    if (!Array.isArray(rows) || rows.length === 0 || groupSize <= 1) return rows
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
 * Map a { timeSpan, multiplier } bar spec to an FMP fetch plan, or null when FMP should NOT
 * serve it (odd multipliers → the caller falls back to Massive/Yahoo). FMP has no native
 * weekly/monthly endpoint, so those fetch daily EOD and group by calendar boundary
 * (`groupBy`). Futures / index / broker symbols still fall back (FMP returns empty → Massive).
 * Pure — exported for testing.
 *   { kind:'intraday', interval } | { kind:'eod', groupBy? }  with `aggregate` group size (1 = none).
 */
export function fmpCandleSpec(timeSpan, multiplier = 1) {
    if (timeSpan === 'minute') {
        return [1, 5, 15, 30].includes(multiplier) ? { kind: 'intraday', interval: `${multiplier}min`, aggregate: 1 } : null
    }
    if (timeSpan === 'hour') {
        if (multiplier === 1) return { kind: 'intraday', interval: '1hour', aggregate: 1 }
        if (multiplier === 4) return { kind: 'intraday', interval: '4hour', aggregate: 1 }   // FMP native 4h
        if (multiplier === 2) return { kind: 'intraday', interval: '1hour', aggregate: 2 }   // aggregate 1h → 2h
        return null
    }
    if (timeSpan === 'day'   && multiplier === 1) return { kind: 'eod', aggregate: 1 }
    if (timeSpan === 'week'  && multiplier === 1) return { kind: 'eod', aggregate: 1, groupBy: 'week' }   // built from daily EOD
    if (timeSpan === 'month' && multiplier === 1) return { kind: 'eod', aggregate: 1, groupBy: 'month' }  // built from daily EOD
    return null   // odd multipliers / unsupported → fallback provider
}

// Calendar-period key for a daily bar's timestamp. Daily EOD bars are timestamped at ET
// midnight (04:00/05:00Z), so their UTC calendar date equals the ET trading date — UTC getters
// are safe here. Week → the Monday (ISO week start) date; month → YYYY-MM.
function _periodKey(tsSec, unit) {
    const dt = new Date(tsSec * 1000)
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth(), d = dt.getUTCDate()
    if (unit === 'month') return `${y}-${String(m + 1).padStart(2, '0')}`
    const dow = dt.getUTCDay()                    // 0=Sun … 6=Sat
    const backToMon = dow === 0 ? 6 : dow - 1     // days back to Monday
    return new Date(Date.UTC(y, m, d - backToMon)).toISOString().slice(0, 10)
}

/**
 * Group ascending daily OHLCV rows into weekly / monthly bars by calendar boundary — FMP has
 * no native week/month endpoint, so we build them from daily EOD. Each period bar: open = its
 * first day, close = its last day, high/low = the extremes, volume = the sum, timestamp = the
 * period's first bar (its open). Pure — exported for testing.
 */
export function groupOhlcByPeriod(rows, unit) {
    if (!Array.isArray(rows) || rows.length === 0) return rows
    const byKey = new Map()
    for (const r of rows) {                       // ascending — first row of each key sets open/timestamp
        const key = _periodKey(r.timestamp, unit)
        const cur = byKey.get(key)
        if (!cur) {
            byKey.set(key, { timestamp: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume || 0 })
        } else {
            cur.high    = Math.max(cur.high, r.high)
            cur.low     = Math.min(cur.low, r.low)
            cur.close   = r.close
            cur.volume += r.volume || 0
        }
    }
    return [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp)
}

/** Map an FMP candle row → the canonical { timestamp, open, high, low, close, volume } or null. */
function _normalizeFmpCandle(r) {
    const t = fmpDateToEpochSec(r?.date)
    const o = Number(r?.open), c = Number(r?.close)
    if (t == null || !Number.isFinite(o) || !Number.isFinite(c)) return null
    const h = Number(r?.high), l = Number(r?.low), v = Number(r?.volume)
    return {
        timestamp: t,
        open:  o,
        high:  Number.isFinite(h) ? h : Math.max(o, c),
        low:   Number.isFinite(l) ? l : Math.min(o, c),
        close: c,
        volume: Number.isFinite(v) ? v : 0,
    }
}

/**
 * OHLCV candles from FMP as the canonical CandleObject[] (drop-in for
 * massive.getTickerAggregates). Returns null when FMP shouldn't serve this bar spec
 * (week/month/odd multiplier) so the caller can fall back. `from`/`to` are epoch ms.
 *
 * @param {string} ticker
 * @param {{ timeSpan?: string, multiplier?: number, from?: number, to?: number }} options
 * @returns {Promise<Array<{timestamp,open,high,low,close,volume}> | null>}
 */
export async function getFmpCandles(ticker, options = {}) {
    const { timeSpan = 'day', multiplier = 1, from, to } = options
    const spec = fmpCandleSpec(timeSpan, multiplier)
    if (!spec) return null

    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) return null
    if (!API_KEY) throw new Error('FMP_API_KEY is not set')

    const dateStr = (ms) => new Date(ms).toISOString().slice(0, 10)
    const parts = [`symbol=${encodeURIComponent(sym)}`]
    if (from != null) parts.push(`from=${dateStr(from)}`)
    if (to   != null) parts.push(`to=${dateStr(to)}`)
    const qs   = `${parts.join('&')}&apikey=${API_KEY}`
    const path = spec.kind === 'intraday' ? `/historical-chart/${spec.interval}?${qs}` : `/historical-price-eod/full?${qs}`

    const rows   = await getJson(`${BASE}${path}`, { label: `FMP candles ${sym}/${timeSpan}x${multiplier}` })
    const mapped = (Array.isArray(rows) ? rows : [])
        .map(_normalizeFmpCandle)
        .filter(Boolean)
        .sort((a, b) => a.timestamp - b.timestamp)   // ascending — aggregation + downstream expect it

    if (spec.groupBy) return groupOhlcByPeriod(mapped, spec.groupBy)   // week/month built from daily EOD
    return spec.aggregate > 1 ? aggregateOhlc(mapped, spec.aggregate) : mapped
}
