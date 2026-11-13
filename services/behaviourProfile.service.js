// PROTEUS'S PROFILE, FETCHED AND KEPT (docs/design/proteus.md §5, §9). The engine (behaviourProfile.engine.js) counts;
// this file gets it the bars and keeps the answer: one profile per symbol, the house's (it binds to no account, like
// coverage), re-computed WEEKLY — a name already profiled this week costs nothing whoever asks.
//
// Bars, per timeframe: 5-minute ~3 months (FMP serves ~9 sessions a call → paged by week), 1-hour ~1 year (paged by
// ~2 months), daily ~10 years (one call), weekly built from the daily (FMP serves no weekly bars). ~22 provider calls
// for a new name: the three timeframes in parallel, each one's pages ONE AT A TIME (22 at once per name invited the
// provider's rate limit, and a limited page falls back to another provider — two sources in one series; CR
// 2026-11-12). A page that fails is skipped, not the profile. The first profile of a name takes seconds, the rest of
// the week none.
//
// KEPT: the PROFILE only (a few KB), never the bars — a 5-minute history per name would eat the 512 MB Atlas quota
// (memory: project_atlas_quota) as the board names pile up; re-fetching once a week is ~20 calls. (The design doc's
// §9 "keep and top up" is superseded by this.)
//
// One profile computing per symbol at a time: a second ask for the same name waits on the first.

import { getTickerAggregates } from '../providers/candles.provider.js'
import { makeMongoBackedCache } from './mongoCache.util.js'
import { behaviourProfile } from './behaviourProfile.engine.js'
import { toWeekly } from './swingStructure.service.js'
import { logger } from './logger.service.js'

const LOG = '[behaviourProfile]'
const DAY = 86_400_000
export const PROFILE_COLLECTION = 'proteus_profiles'
/** A profile is good for a week (proteus.md §5). */
export const PROFILE_TTL_MS = 7 * DAY
/** Bump when the engine's numbers change meaning — an older stored profile is then recomputed, not served. */
// 2 (2026-11-12, CR): found out of sample, order blocks once known, the drift spaced, every swing low swept.
// 3 (2026-11-12): the daily view on ~10 years, not 5.
// 4 (2026-11-13): each timeframe's latest false break, the example shown on a chart.
// 5 (2026-11-13): the price-cycle test (cycleTest — proteus.md §8.1).
// 6 (2026-11-13): the false-break rate against chance (falseBreakChance).
// 7 (2026-11-13): Wyckoff, measured — ranges, springs, breakouts, dry-up retests (wyckoffTest).
// 8 (2026-11-13): Fibonacci pullbacks, measured (fibPullbackTest).
// 9 (2026-11-13): the stop's room on the trader's own swing lows (stopRoom) and each line's level now (5b).
export const PROFILE_VERSION = 9

const _cache = makeMongoBackedCache({ collection: PROFILE_COLLECTION, ttlMs: PROFILE_TTL_MS, max: 300, log: LOG })
const _inflight = new Map()

const _ms = (ts) => (ts < 1e12 ? ts * 1000 : ts)
const _etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

/** Paged bars over `spanDays`, one call per `pageDays`, one page at a time; oldest → newest, de-duplicated. A failed
 *  page is logged and skipped. */
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

/**
 * Daily bars → weekly (swingStructure.toWeekly), each week stamped at its Monday's open. The week still in progress
 * (its Saturday not reached at `now`) is left out: a part-week is not a weekly bar, and it would skew the ATR (CR
 * 2026-11-12). Pure.
 */
export function weeklyFromDaily(day, now = Date.now()) {
    return toWeekly((day ?? []).map(b => ({ ...b, date: _etDate.format(new Date(_ms(b.timestamp))) })))
        .filter(b => Date.parse(`${b.date}T00:00:00Z`) + 5 * DAY <= now)
        .map(b => ({ ...b, timestamp: Date.parse(`${b.date}T14:30:00Z`) / 1000 }))
}

/** The four timeframes' bars for a symbol. `deps.get` — the candle fetch (a test seam). */
export async function fetchProfileBars(symbol, { get = getTickerAggregates, now = Date.now() } = {}) {
    const sym = String(symbol).toUpperCase()
    const [five, hour, daily] = await Promise.all([
        _paged(get, sym, 'minute', 5, 92, 7, now),
        _paged(get, sym, 'hour', 1, 365, 60, now),
        get(sym, { timeSpan: 'day', multiplier: 1, from: now - 10 * 365 * DAY, to: now }),
    ])
    const day = daily ?? []
    // The daily view reads all ~10 years (Roy, 2026-11-12): found on the older two-thirds alone, 5 years gave a moving
    // average ~20 touches — too few to reach z 3 even for a strong rule (design §10).
    return { '5min': five, '1hour': hour, day, week: weeklyFromDaily(day, now) }
}

/**
 * This week's STORED profile, or null — never computes. What a list reads for many names at once (the Hotlist badge,
 * proteus.md step 5): a name not profiled yet shows nothing rather than holding up the list for seconds of FMP calls.
 */
export async function storedProfile(symbol, { deps = {} } = {}) {
    const sym = String(symbol ?? '').trim().toUpperCase()
    if (!sym) return null
    const hit = await (deps.cache ?? _cache).read(sym)
    // The profile's OWN age decides, not the cache's: a stored profile read back into memory restarts the memory
    // layer's clock, which would serve a 6-day-old profile for another week (CR 2026-11-12).
    const age = (deps.now ?? Date.now()) - Date.parse(hit?.computed_at ?? '')
    return hit?.version === PROFILE_VERSION && hit.profile && age < PROFILE_TTL_MS ? { ...hit.profile, computed_at: hit.computed_at } : null
}

/**
 * The symbol's profile: this week's stored one, or a new one computed now and stored. `{ fresh: true }` recomputes
 * regardless. → `{ ...profile, computed_at }`; throws when the bars cannot be fetched (the caller says so).
 */
export async function profileFor(symbol, { fresh = false, deps = {} } = {}) {
    const sym = String(symbol ?? '').trim().toUpperCase()
    if (!sym) throw new Error('a symbol is required')
    const cache = deps.cache ?? _cache
    if (!fresh) {
        const stored = await storedProfile(sym, { deps })
        if (stored) return stored
    }
    if (_inflight.has(sym)) return _inflight.get(sym)
    const run = (async () => {
        const bars = await fetchProfileBars(sym, deps)
        if (!bars.day.length) throw new Error(`no price history for ${sym}`)
        const profile = behaviourProfile(sym, bars)
        const computed_at = new Date(deps.now ?? Date.now()).toISOString()
        await cache.write(sym, { version: PROFILE_VERSION, profile, computed_at })
        logger.info(LOG, `${sym} profiled (${Object.entries(bars).map(([k, v]) => `${k} ${v.length}`).join(', ')})`)
        return { ...profile, computed_at }
    })()
    _inflight.set(sym, run)
    try { return await run } finally { _inflight.delete(sym) }
}
