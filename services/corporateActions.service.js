// CORPORATE ACTIONS — the one place the app learns a stock split (2026-11-22; Roy: "on this daily fetch catch also the
// split event"). SNDK split 8-for-1 on 2026-11-20 and nothing noticed: FMP's price history is split-adjusted the day it
// happens, every number the app had stored was not, so the $1,710 target sat over a $105 price as a +1,500% strong buy.
//
// A split changes no value — only the number of shares — so every PER-SHARE number set before it divides by the ratio
// (numerator / denominator: 8-for-1 → 8, a 1-for-5 reverse split → 0.2). This module answers "has this name split since
// that day, and by how much" — one FMP calendar read for every name, cached — and does the arithmetic. What to restate is
// each owner's: the coverage monitor restates coverage and its scorecard calls (coverage.service applySplit). Positions,
// setups and paper fills are NOT restated yet.

import { logger } from './logger.service.js'

const LOG = '[corporateActions]'
const DAY_MS = 86_400_000
/** How far back the calendar is read — a split older than this, never seen by a tick, is not caught. */
export const LOOKBACK_DAYS = 60
/** The calendar is read at most this often. */
const TTL_MS = 6 * 60 * 60 * 1000
/** After a failed read, the next one waits this long. */
const RETRY_MS = 30 * 60 * 1000

/**
 * The NEW YORK calendar day of an instant (YYYY-MM-DD). A split takes effect at the open of its date in New York: by
 * the UTC date the evening before (19:00 ET on) already reads as the split day while the stock still trades pre-split
 * (code review, 2026-11-22). Every "before / after the split" here is asked in this day. Pure.
 */
export const etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

/** The instant a New York day starts (00:00 ET, EST or EDT). Pure. */
export function etMidnightMs(date) {
    for (const off of ['05', '04']) {
        const ms = Date.parse(`${date}T${off}:00:00Z`)
        if (new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).startsWith('00:')) return ms
    }
    return Date.parse(`${date}T05:00:00Z`)
}

const _day = etDay
// Lazy: coverage.service imports the arithmetic, and must not load the provider stack for it.
const _io = {
    calendar: async (from, to) => (await import('../providers/fmp.provider.js')).getSplitsCalendarRaw(from, to),
    now: () => Date.now(),
}
let _cache = null   // { at, rows }
/** Test seam — also clears the cache. */
export function _setCorporateActionsIO(io) { Object.assign(_io, io); _cache = null }

/** How much a split divides a per-share number by (8-for-1 → 8; 1-for-5 → 0.2), or null when it is not a split. Pure. */
export function splitRatio(split) {
    const n = Number(split?.numerator), d = Number(split?.denominator)
    if (!(n > 0) || !(d > 0) || !Number.isFinite(n / d) || n === d) return null
    return n / d
}

/**
 * A per-share number restated after a split, anything else left as it is. Rounded to the cent from $1 up, to 4 places
 * under it — a $0.37 average ÷ 8 is $0.0462, not $0.05. Pure.
 */
export function perShare(value, ratio) {
    const v = Number(value)
    if (value == null || value === '' || !Number.isFinite(v) || !(ratio > 0)) return value
    const x = v / ratio
    const k = Math.abs(x) >= 1 ? 100 : 10_000
    return Math.round(x * k) / k
}

/** A split in words for a person — "prices ÷ 8, shares × 8" / a reverse split "prices × 20, shares ÷ 20". Pure. */
export function splitEffect(ratio) {
    if (ratio >= 1) return `prices ÷ ${ratio}, shares × ${ratio}`
    const inv = Math.round((1 / ratio) * 1000) / 1000
    return `prices × ${inv}, shares ÷ ${inv}`
}

/** The splits of `symbol` dated strictly after `sinceDay` and on or before `today`, oldest first. Pure. */
export function splitsAfter(rows, symbol, sinceDay, today) {
    const sym = String(symbol ?? '').toUpperCase()
    return (rows ?? [])
        .filter(r => String(r?.symbol ?? '').toUpperCase() === sym && typeof r.date === 'string'
            && (!sinceDay || r.date > sinceDay) && r.date <= today && splitRatio(r) !== null)
        .map(r => ({ symbol: sym, date: r.date, numerator: Number(r.numerator), denominator: Number(r.denominator), ratio: splitRatio(r) }))
        .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * The splits of `symbol` since `sinceDay` (YYYY-MM-DD; exclusive) → `[{ symbol, date, numerator, denominator, ratio }]`.
 * Never throws: a failed read is [] (logged) — the daily check goes on and the next one asks again.
 */
export async function splitsSince(symbol, sinceDay) {
    const nowMs = _io.now()
    try {
        if (!_cache || nowMs - _cache.at > TTL_MS) {
            const rows = await _io.calendar(_day(nowMs - LOOKBACK_DAYS * DAY_MS), _day(nowMs))
            _cache = { at: nowMs, rows: Array.isArray(rows) ? rows : [] }
        }
        return splitsAfter(_cache.rows, symbol, sinceDay, _day(nowMs))
    } catch (err) {
        logger.warn(LOG, 'split calendar read failed — no split caught this time', err.message)
        // Not asked again by every name of the tick: the next read is in RETRY_MS. Nothing is lost — a missed split is
        // still in the calendar's window then.
        _cache = { at: nowMs - TTL_MS + RETRY_MS, rows: [] }
        return []
    }
}

/** Every split in the calendar window up to today, all names → the same rows as splitsSince. Never throws. */
export async function recentSplits() {
    const nowMs = _io.now()
    await splitsSince('', null)   // fills (or refreshes) the cache
    const today = _day(nowMs)
    const syms = [...new Set((_cache?.rows ?? []).map(r => String(r?.symbol ?? '').toUpperCase()).filter(Boolean))]
    return syms.flatMap(s => splitsAfter(_cache.rows, s, null, today))
}

export const corporateActionsService = { splitsSince, recentSplits }
