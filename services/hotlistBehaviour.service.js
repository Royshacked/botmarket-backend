// HOW A HOTLIST NAME TRADES (docs/design/proteus.md §8.1 decision 4, Roy 2026-11-13): the technical analyst's measured
// profile, shown in the OPENED row on its horizon — "instead of a badge" (the step-5 badge is gone). One name, opened by
// the user, so a profile not stored yet is computed now (~10 s on a first look; a week's cache after that).
//
// And the covered book's weekly profile (Roy, option b): the Swing and Long term names are queued after the weekly run
// (pythiaWeekly), so opening one of their rows is instant.

import { profileFor } from './behaviourProfile.service.js'
import { rowProfile, BADGE_TIMEFRAMES } from './tools/behaviourProfile.tools.js'
import { queueProfiles } from './proteusQueue.service.js'
import { houseBook } from './houseBook.service.js'
import { logger } from './logger.service.js'

const LOG = '[hotlistBehaviour]'
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/

const _deps = {
    profile: (sym) => profileFor(sym),
    queue:   (symbols, opts) => queueProfiles(symbols, opts),
    book:    () => houseBook(),
}

/**
 * One opened row: `{ symbol, horizon, computed_at, headline, lines, on }`, or `{ symbol, horizon, reason }` — `bad_symbol`,
 * `no_history` (the profile could not be measured), `too_short` (no bars on this horizon's timeframes). Never throws.
 */
export async function profileRow(symbol, horizon = null, deps = _deps) {
    const sym = String(symbol ?? '').trim().toUpperCase()
    const h = Object.hasOwn(BADGE_TIMEFRAMES, horizon) ? horizon : 'swing'
    if (!SYMBOL.test(sym)) return { symbol: sym, horizon: h, reason: 'bad_symbol' }
    let p
    try {
        p = await deps.profile(sym)
    } catch (err) {
        logger.warn(LOG, `${sym}: not measured — ${err.message}`)
        return { symbol: sym, horizon: h, reason: 'no_history' }
    }
    const row = rowProfile(p, h)
    if (!row) return { symbol: sym, horizon: h, reason: 'too_short' }
    return { symbol: sym, horizon: h, computed_at: p.computed_at ?? null, ...row }
}

/**
 * The weekly profile of the house's Swing and Long term names — queued for the technical analyst's measured profile
 * after the weekly run (pythiaWeekly), so their rows open with it ready. A name profiled this week costs nothing (the
 * profile's week cache). Never throws. → how many were queued.
 */
export async function profileHouseBook(deps = _deps) {
    try {
        const b = await deps.book()
        const syms = [...new Set([...(b?.swing ?? []), ...(b?.long_term ?? [])].map(r => String(r?.symbol ?? '').toUpperCase()).filter(s => SYMBOL.test(s)))]
        const n = syms.length ? (deps.queue(syms.sort(), { source: 'house_book_weekly' }) ?? 0) : 0
        logger.info(LOG, `the house book queued for its weekly profile: ${n} of ${syms.length} name(s)`)
        return n
    } catch (err) {
        logger.warn(LOG, 'the house book was not queued', err.message)
        return 0
    }
}
