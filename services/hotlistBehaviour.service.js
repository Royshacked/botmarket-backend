// HOW A HOTLIST NAME TRADES (Roy 2026-11-13; since 2026-11-21 Proteus v2 — docs/design/proteus-v2.md §5): the measured
// profile on the row's horizon's SCALE, shown in the OPENED row as bottom lines. One name, opened by the user, so a scale
// not stored yet is built now (seconds; valid a week, the day scale a day).

import { profileFor } from './stockProfile.service.js'
import { rowLines } from './stockProfile.format.js'
import { logger } from './logger.service.js'

const LOG = '[hotlistBehaviour]'
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/

/** The Hotlist's horizon keys → the profile's scale (proteus-v2 §2b). */
export const ROW_SCALE = Object.freeze({ intraday: 'day', day: 'day', week: 'short', swing: 'swing', long_term: 'long' })

const _deps = {
    profile: (sym, scale) => profileFor(sym, { scales: [scale] }),
}

/**
 * One opened row: `{ symbol, horizon, computed_at, headline, lines }`, or `{ symbol, horizon, reason }` — `bad_symbol`,
 * `no_history` (the profile could not be measured), `unavailable` (its daily bars could not be fetched just now — try
 * again), `too_short` (not enough bars on this horizon's scale). Never throws.
 */
export async function profileRow(symbol, horizon = null, deps = _deps) {
    const sym = String(symbol ?? '').trim().toUpperCase()
    const h = Object.hasOwn(ROW_SCALE, horizon) ? horizon : 'swing'
    if (!SYMBOL.test(sym)) return { symbol: sym, horizon: h, reason: 'bad_symbol' }
    const scale = ROW_SCALE[h]
    let entry
    try {
        entry = await deps.profile(sym, scale)
    } catch (err) {
        logger.warn(LOG, `${sym}: not measured — ${err.message}`)
        return { symbol: sym, horizon: h, reason: err?.code === 'DAILY_UNAVAILABLE' ? 'unavailable' : 'no_history' }
    }
    const row = rowLines(entry, scale)
    if (!row.headline) return { symbol: sym, horizon: h, reason: row.reason ?? 'too_short' }
    return { symbol: sym, horizon: h, computed_at: entry.built?.[scale] ?? null, headline: row.headline, lines: row.lines }
}
