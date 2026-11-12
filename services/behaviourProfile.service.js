// PROTEUS'S PROFILE, FETCHED AND KEPT (docs/design/proteus.md §5, §9). The engine (behaviourProfile.engine.js) counts;
// this file gets it the bars and keeps the answer: one profile per symbol, the house's (it binds to no account, like
// coverage), re-computed WEEKLY — a name already profiled this week costs nothing whoever asks.
//
// Bars, per timeframe: 5-minute ~3 months (FMP serves ~9 sessions a call → paged by week), 1-hour ~1 year (paged by
// ~2 months), daily ~10 years (one call), weekly built from the daily (FMP serves no weekly bars). ~20 provider calls
// for a new name, fetched in parallel; the first profile of a name takes seconds, the rest of the week none.
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
export const PROFILE_VERSION = 1

const _cache = makeMongoBackedCache({ collection: PROFILE_COLLECTION, ttlMs: PROFILE_TTL_MS, max: 300, log: LOG })
const _inflight = new Map()

const _ms = (ts) => (ts < 1e12 ? ts * 1000 : ts)
const _etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

/** Paged bars over `spanDays`, one call per `pageDays`, in parallel; oldest → newest, de-duplicated. */
async function _paged(get, sym, timeSpan, multiplier, spanDays, pageDays, now) {
    const pages = []
    for (let to = now; to > now - spanDays * DAY; to -= pageDays * DAY) {
        pages.push(get(sym, { timeSpan, multiplier, from: to - pageDays * DAY, to }))
    }
    const byTs = new Map()
    for (const rows of await Promise.all(pages)) for (const b of rows ?? []) byTs.set(b.timestamp, b)
    return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp)
}

/** Daily bars → weekly (swingStructure.toWeekly), each week stamped at its Monday's open. Pure. */
export function weeklyFromDaily(day) {
    return toWeekly((day ?? []).map(b => ({ ...b, date: _etDate.format(new Date(_ms(b.timestamp))) })))
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
    return { '5min': five, '1hour': hour, day: day.slice(-1260), week: weeklyFromDaily(day) }
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
        const hit = await cache.read(sym)
        if (hit?.version === PROFILE_VERSION && hit.profile) return { ...hit.profile, computed_at: hit.computed_at }
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
