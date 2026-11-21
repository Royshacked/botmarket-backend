// PROTEUS v2, FETCHED AND KEPT (docs/design/proteus-v2.md §4). The engine (stockProfile.engine.js) measures; this file gets
// it the bars and keeps the answer: one profile per symbol, the house's (it binds to no account, like coverage).
//
// VALID (P2): 7 days for the swing and long-term scales; the DAY scale 1 day (its window is 3 months of 15-minute bars).
// `profileFor(sym, { scale })` serves a valid stored profile or builds a new one — seconds, code only, no model.
//
// BARS: 5-minute ~3 months (FMP serves ~9 sessions a call → paged by week, one page at a time) → 15-minute; daily ~10 years
// from FMP only (a short fallback history would mis-measure the long scale — fmpDaily); every scale but the day reads it (v2).
// KEPT: the profile only (a few KB), never the bars (the 512 MB Atlas quota — memory: project_atlas_quota).
//
// One build per symbol at a time: a second ask for the same name waits on the first.

import { getTickerAggregates, _deps as candleDeps } from '../providers/candles.provider.js'
import { getFmpCandles } from '../providers/fmp.price.provider.js'
import { makeMongoBackedCache } from './mongoCache.util.js'
import { SCALES, VERSION, scaleProfile, levelsAt, scaleOf } from './stockProfile.engine.js'

export { scaleOf, isDayTrade } from './stockProfile.engine.js'
import { logger } from './logger.service.js'

const LOG = '[stockProfile]'
const DAY = 86_400_000
export const PROFILE_COLLECTION = 'stock_profiles'
/** How long each scale's read stays valid (§4). */
export const VALID_MS = Object.freeze({ day: 1 * DAY, short: 7 * DAY, swing: 7 * DAY, long: 7 * DAY })

const _cache = makeMongoBackedCache({ collection: PROFILE_COLLECTION, ttlMs: VALID_MS.swing, max: 300, log: LOG })
const _inflight = new Map()
const _ms = (ts) => (ts < 1e12 ? ts * 1000 : ts)

/** Paged bars over `spanDays`, one call per `pageDays`, one page at a time; oldest → newest, de-duplicated. A failed page
 *  is logged and skipped. */
async function _paged(get, sym, timeSpan, multiplier, spanDays, pageDays, now) {
    const byTs = new Map()
    for (let to = now; to > now - spanDays * DAY; to -= pageDays * DAY) {
        try {
            for (const b of (await get(sym, { timeSpan, multiplier, from: to - pageDays * DAY, to })) ?? []) byTs.set(b.timestamp, b)
        } catch (err) {
            logger.warn(LOG, `${sym} ${multiplier}${timeSpan} page to ${new Date(to).toISOString().slice(0, 10)} skipped: ${err.message}`)
        }
    }
    return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp)
}

/** 5-minute bars → 15-minute: the bars of one 15-minute slot make one bar, stamped at its first (the session opens at :30,
 *  a multiple of 15, so no slot straddles the open). Pure. */
export function fifteenFromFive(five) {
    const out = []
    let cur = null, key = null
    for (const b of five ?? []) {
        const k = Math.floor(_ms(b.timestamp) / (15 * 60_000))
        if (k !== key) {
            if (cur) out.push(cur)
            key = k
            cur = { timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }
        } else {
            cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume ?? 0
        }
    }
    if (cur) out.push(cur)
    return out
}

/** The daily fetch's tries and the waits between them (ms). */
export const DAILY_TRIES = Object.freeze([0, 3_000, 10_000])

/**
 * The daily bars from FMP ONLY — no fallback on a failure (Roy, 2026-11-17): the router's fallback serves ~2 years, which
 * would mis-measure the long scale and be kept a week. FMP is tried `DAILY_TRIES` times; still failing → an error with
 * `code` DAILY_UNAVAILABLE (try later). FMP answering EMPTY (a symbol it does not cover) is not a failure: the fallback.
 */
export async function fmpDaily(sym, options, { fmp = getFmpCandles, router = getTickerAggregates, sleep = (ms) => new Promise(r => setTimeout(r, ms)), tries = DAILY_TRIES } = {}) {
    let last = null
    for (const wait of tries) {
        if (wait) await sleep(wait)
        try {
            const rows = await fmp(sym, options)
            if (Array.isArray(rows) && rows.length) return rows
            return (await router(sym, options)) ?? []
        } catch (err) {
            last = err
            logger.warn(LOG, `${sym} daily from FMP failed (${err.status ?? err.message}) — ${wait === tries.at(-1) ? 'not profiled now' : 'retrying'}`)
        }
    }
    const err = new Error(`the daily history could not be fetched just now (${last?.message ?? 'FMP failed'}) — try again later`)
    err.code = 'DAILY_UNAVAILABLE'
    err.status = last?.status
    throw err
}

/** Timestamps in seconds (the engine's), oldest first. */
const _secs = (bars) => (bars ?? []).map(b => ({ ...b, timestamp: b.timestamp > 1e12 ? Math.floor(b.timestamp / 1000) : b.timestamp })).sort((a, b) => a.timestamp - b.timestamp)

/** The bars of each scale. `get` — the candle fetch (a test seam); the daily through `fmpDaily` unless a test passes its own. */
export async function fetchScaleBars(symbol, { get = getTickerAggregates, getDaily = null, now = Date.now(), scales = ['day', 'short', 'swing', 'long'] } = {}) {
    const sym = String(symbol).toUpperCase()
    const dailyOf = getDaily ?? (get === getTickerAggregates && candleDeps.useFmp ? (s, o) => fmpDaily(s, o) : get)
    const wantDay = scales.includes('day'), wantDaily = scales.some(s => s !== 'day')
    const [five, daily] = await Promise.all([
        wantDay ? _paged(get, sym, 'minute', 5, 92, 7, now) : [],
        wantDaily ? dailyOf(sym, { timeSpan: 'day', multiplier: 1, from: now - 10 * 365 * DAY, to: now }) : [],
    ])
    const day = _secs(daily)
    // Every scale but the day on the DAILY bars since v2 (its σ over the horizon, stockProfile.engine SCALES).
    return { day: _secs(fifteenFromFive(five)), short: day, swing: day, long: day }
}

/** A scale's read is valid when it was built with this engine's version within its window. */
export function isValid(entry, scale, now = Date.now()) {
    return entry?.version === VERSION && !!entry.scales?.[scale] && now - Date.parse(entry.built?.[scale] ?? '') < VALID_MS[scale]
}

/** The STORED profile, never building; `scale` → null unless that scale is valid. */
export async function storedProfile(symbol, { scale = null, deps = {} } = {}) {
    const sym = String(symbol ?? '').trim().toUpperCase()
    if (!sym) return null
    const hit = await (deps.cache ?? _cache).read(sym)
    if (!hit || hit.version !== VERSION) return null
    const now = deps.now ?? Date.now()
    if (scale && !isValid(hit, scale, now)) return null
    return hit
}

/**
 * The symbol's profile with `scales` valid — the stored one, or the stale / missing scales built now and stored with the
 * rest. `{ fresh: true }` rebuilds them regardless. → `{ symbol, version, scales: { day, short, swing, long }, built }`; throws when
 * the bars cannot be fetched (the caller says so).
 */
export async function profileFor(symbol, { scales = ['day', 'short', 'swing', 'long'], fresh = false, deps = {} } = {}) {
    const sym = String(symbol ?? '').trim().toUpperCase()
    if (!sym) throw new Error('a symbol is required')
    const cache = deps.cache ?? _cache
    const now = deps.now ?? Date.now()
    const hit = await cache.read(sym)
    const have = hit?.version === VERSION ? hit : null
    const need = scales.filter(s => fresh || !isValid(have, s, now))
    if (!need.length) return have
    const key = `${sym}|${need.join(',')}`
    if (_inflight.has(key)) return _inflight.get(key)
    const run = (async () => {
        const bars = await fetchScaleBars(sym, { ...deps, now, scales: need })
        if (need.some(s => s !== 'day') && !bars.swing.length) throw new Error(`no price history for ${sym}`)
        // Merged onto what is stored NOW, not what was read before the fetch: a build of another scale for the same name
        // may have landed meanwhile (Axl's swing beside Mentor's day trade) — the last write must not drop it.
        const cur = await cache.read(sym).catch(() => null)
        const base = cur?.version === VERSION ? cur : have
        const entry = { symbol: sym, version: VERSION, scales: { ...(base?.scales ?? {}) }, built: { ...(base?.built ?? {}) } }
        for (const s of need) { entry.scales[s] = scaleProfile(bars[s], SCALES[s]); entry.built[s] = new Date(now).toISOString() }
        await cache.write(sym, entry)
        logger.info(LOG, `${sym} profiled: ${need.map(s => `${s} ${bars[s].length} bars`).join(', ')}`)
        return entry
    })()
    _inflight.set(key, run)
    try { return await run } finally { _inflight.delete(key) }
}

/** Where the stop and the target go for `ratio` on the symbol at `horizon` (§3) — Mentor's question. */
export async function levelsFor(symbol, ratio, { horizon = 'swing', side = 'long', deps = {} } = {}) {
    const scale = scaleOf(horizon)
    const entry = await profileFor(symbol, { scales: [scale], deps })
    const prof = entry.scales[scale]
    if (!prof?.enough) return { symbol: entry.symbol, scale, enough: false, reason: prof?.reason ?? 'too_short' }
    const out = levelsAt(prof, Number(ratio), side)
    return out ? { symbol: entry.symbol, enough: true, ...out } : { symbol: entry.symbol, scale, enough: false, reason: 'too_few_swings' }
}
