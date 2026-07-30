/**
 * "Anything coming up?" — the dated events that could move what this user actually cares about.
 *
 * ── WHY THIS EXISTS RATHER THAN REUSING get_earnings_calendar ─────────────────
 * That tool is market-wide and needs an explicit `from`/`to`; with no symbols it answers with
 * whatever reports that week, which for a concierge question is dozens of unrelated tickers. To
 * make it personal an agent has to list its own artifacts, extract the symbols, and call the
 * calendar with them — a 2-hop chain the model half-completes, and one that hands a JOIN to a
 * language model. A join is a computation, not a judgment: it belongs in code, and
 * computePortfolioState already does this exact one server-side for a portfolio's holdings.
 *
 * So the join happens here, once, and the answer arrives in one hop.
 *
 * Earnings and the Fed calendar are kept apart in the result rather than merged into one feed:
 * they come from different providers on different cadences, and only earnings is joinable to a
 * symbol at all — a rate decision is everyone's event.
 *
 * NOTE for later: the earnings-by-symbol join now exists here AND in portfolioState.service.js.
 * Extracting a shared `earningsBySymbol(symbols, {from,to})` is the right consolidation; it is
 * deliberately not done in the same change that introduces the second caller.
 */

import { logger } from './logger.service.js'
import { getEarningsCalendarRaw } from '../providers/fmp.provider.js'
import { calendarService } from '../api/calendar/calendar.service.js'
import { listWatchedItems } from './watchlist.service.js'

const LOG = '[upcomingEvents]'
const DEFAULT_WINDOW_DAYS = 30

const _iso = (ms) => new Date(ms).toISOString().slice(0, 10)

/**
 * Every name this user has a stake in: the symbol on a call/setup/coverage row, plus the holdings
 * inside each book (which the book row carries so this needs no second query).
 */
export function symbolsFromWatched(items = []) {
    const out = new Set()
    for (const row of items) {
        if (row?.symbol) out.add(String(row.symbol).toUpperCase())
        for (const s of (row?.detail?.symbols ?? [])) if (s) out.add(String(s).toUpperCase())
    }
    return [...out]
}

/**
 * @param {string} userId
 * @param {object} [opts]
 * @param {string} [opts.scope='mine']  'mine' joins earnings to the user's names; 'market' does not
 * @param {string} [opts.from]  YYYY-MM-DD, defaults to today
 * @param {string} [opts.to]    YYYY-MM-DD, defaults to +30d
 * @returns {Promise<{asOf:number, from:string, to:string, scope:string, symbols:string[], earnings:object[], fed:object[], unavailable:string[]}>}
 */
export async function getUpcomingEvents(userId, { scope = 'mine', from = null, to = null } = {}, deps = {}) {
    const {
        earningsRaw = getEarningsCalendarRaw,
        fed = () => calendarService.getFed(),
        watched = listWatchedItems,
        now = Date.now(),
    } = deps

    const f = from ?? _iso(now)
    const t = to ?? _iso(now + DEFAULT_WINDOW_DAYS * 864e5)
    const mine = scope !== 'market'

    // Resolve the user's names FIRST when scoping to them: with an empty symbol set the calendar
    // would fall back to market-wide, which is the opposite of what was asked.
    let symbols = []
    const unavailable = []
    if (mine && userId) {
        try {
            const { items } = await watched(userId, { kinds: ['call', 'setup', 'coverage', 'portfolio'] })
            symbols = symbolsFromWatched(items)
        } catch (err) {
            logger.warn(LOG, 'could not resolve watched symbols', err.message)
            unavailable.push('symbols')
        }
    }

    // A personal scope with nothing to join to is answered honestly — no earnings, rather than
    // everyone's earnings. The Fed rows still come back: they apply to the user regardless.
    const wantEarnings = !mine || symbols.length > 0
    const [earningsRes, fedRes] = await Promise.allSettled([
        wantEarnings ? earningsRaw(f, t, mine ? symbols : []) : Promise.resolve([]),
        fed(),
    ])

    let earnings = []
    if (earningsRes.status === 'fulfilled') {
        earnings = Array.isArray(earningsRes.value) ? earningsRes.value : []
    } else {
        logger.warn(LOG, 'earnings read failed', earningsRes.reason?.message)
        unavailable.push('earnings')
    }

    let fedItems = []
    if (fedRes.status === 'fulfilled') {
        fedItems = Array.isArray(fedRes.value?.items) ? fedRes.value.items : []
    } else {
        logger.warn(LOG, 'fed read failed', fedRes.reason?.message)
        unavailable.push('fed')
    }

    // The Fed provider works to its own 45-day horizon, so trim it to the window that was asked
    // for — otherwise "anything this week?" answers with next month's meeting too.
    fedItems = fedItems.filter(i => !i?.date || (i.date >= f && i.date <= t))

    return { asOf: now, from: f, to: t, scope: mine ? 'mine' : 'market', symbols, earnings, fed: fedItems, unavailable }
}
