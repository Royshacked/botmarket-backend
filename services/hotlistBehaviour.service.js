// THE HOTLIST BADGE (docs/design/proteus.md §8.2, build step 5, 2026-11-13): what each name on a list obeys, in a word
// or two, from its MEASURED profile — read from the week's store, never computed here (a list of 80 names must not wait on
// 80 × ~15 FMP calls). A name with no profile yet gets none, and is queued for one (proteusQueue — one at a time, the
// loop leader only), so its badge is there the next time the list is looked at.

import { storedProfile } from './behaviourProfile.service.js'
import { behaviourBadge, BADGE_TIMEFRAMES } from './tools/behaviourProfile.tools.js'
import { queueProfiles } from './proteusQueue.service.js'
import { houseBook } from './houseBook.service.js'
import { logger } from './logger.service.js'

const LOG = '[hotlistBehaviour]'
export const MAX_SYMBOLS = 150
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/

// The COVERED BOOK's horizons (Roy, 2026-11-13, option b): ~340 names — profiled once a week, at the weekly run's quiet
// hour (profileHouseBook), never queued from a look at the Hotlist: a first look at Swing would otherwise start ~25
// minutes of FMP calls in market hours. The few names on Intraday / This week still queue on a look.
export const BOOK_HORIZONS = Object.freeze(['swing', 'long_term', 'covered'])

const _deps = {
    stored: (sym) => storedProfile(sym),
    queue:  (symbols, opts) => queueProfiles(symbols, opts),
    book:   () => houseBook(),
}

/**
 * The weekly profile of the house's Swing and Long term names — queued for the technical analyst's measured profile
 * after the weekly run (pythiaWeekly), so their Hotlist badges are ready before anyone looks. A name profiled this week
 * costs nothing (the profile's week cache). Never throws. → how many were queued.
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

/**
 * The badges for a list's names on one horizon. → `{ horizon, badges: { SYM: { badge, holds, tip } | null }, queued }`.
 * Junk symbols are dropped, the list is capped, a failed read is one name without a badge — never a failed list.
 */
export async function badgesFor(symbols, horizon = null, deps = _deps) {
    const h = Object.hasOwn(BADGE_TIMEFRAMES, horizon) ? horizon : 'swing'
    const syms = [...new Set((Array.isArray(symbols) ? symbols : [])
        .map(s => String(s ?? '').trim().toUpperCase()).filter(s => SYMBOL.test(s)))].slice(0, MAX_SYMBOLS)
    const badges = {}
    const missing = []
    await Promise.all(syms.map(async (sym) => {
        try {
            const p = await deps.stored(sym)
            if (!p) { missing.push(sym); badges[sym] = null; return }
            badges[sym] = behaviourBadge(p, h)
        } catch (err) {
            logger.warn(LOG, `${sym}: profile read failed — no badge`, err.message)
            badges[sym] = null
        }
    }))
    let queued = 0
    if (missing.length && !BOOK_HORIZONS.includes(h)) {
        try { queued = deps.queue(missing.sort(), { source: `hotlist_${h}` }) ?? 0 } catch (err) { logger.warn(LOG, 'not queued', err.message) }
    }
    return { horizon: h, badges, queued }
}
