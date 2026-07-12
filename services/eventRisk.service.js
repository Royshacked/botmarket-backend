// Scheduled-catalyst lookup, stamped onto a Kairos call ONCE at build time (not re-fetched by the
// monitor). Merges the symbol's upcoming earnings (Finnhub, equities only) with market-wide Fed/macro
// releases (FRED + static FOMC) inside a day/swing horizon. Hermes reads the frozen `event_risk` list
// and, like a discretionary trader, strongly prefers to wait rather than enter into an unresolved
// binary. Freezing at build is intentional: cheap (one fetch), and fine over a few-days call life.

import { fetchEarningsCalendarByDate } from '../providers/finnhub.provider.js'
import { fetchFedEvents }              from '../providers/fred.provider.js'
import { logger }                      from './logger.service.js'

const LOG = '[eventRisk]'

// How far forward to flag catalysts. Covers the day/swing horizon; Hermes still judges per-call
// relevance against trade_type + valid_until (a 9-days-out event is noise for an intraday call).
const HORIZON_DAYS = 10

// Asset classes that report earnings. Crypto/fx/futures have none, so the earnings fetch is skipped.
const EQUITY_CLASSES = new Set(['equity', 'stock', 'stocks', 'etf'])

// Finnhub earnings `hour`: bmo = before market open, amc = after market close, dmh = during hours.
function _earningsWhen(hour) {
    if (hour === 'bmo') return 'pre_market'
    if (hour === 'amc') return 'after_hours'
    return 'during_session'
}

/**
 * Build the frozen scheduled-catalyst list for a call. Never throws — both providers swallow their
 * own errors and return safe empties, and each lookup is independently guarded, so a failure just
 * yields fewer (or zero) events. Low-impact macro (weekly claims, housing) is dropped as noise.
 *
 * @param {{ asset: string, assetClass?: string, now?: number }} call
 * @param {{ fetchEarnings?: Function, fetchFed?: Function }} deps  injectable for tests
 * @returns {Promise<Array<{type,label,date,when,impact,time?}>>}  soonest-first
 */
export async function buildEventRisk(
    { asset, assetClass, now = Date.now() } = {},
    deps = {},
) {
    const fetchEarnings = deps.fetchEarnings ?? fetchEarningsCalendarByDate
    const fetchFed      = deps.fetchFed      ?? fetchFedEvents

    const symbol = String(asset || '').toUpperCase()
    if (!symbol) return []

    const fromISO = new Date(now).toISOString().slice(0, 10)
    const toISO   = new Date(now + HORIZON_DAYS * 864e5).toISOString().slice(0, 10)

    const events = []

    // Earnings — equities only. The calendar is by-date-window (all symbols); filter to ours.
    if (EQUITY_CLASSES.has(String(assetClass || '').toLowerCase())) {
        try {
            const cal  = await fetchEarnings(fromISO, toISO)
            const rows = Array.isArray(cal?.earningsCalendar) ? cal.earningsCalendar : []
            for (const r of rows) {
                if (String(r?.symbol || '').toUpperCase() !== symbol) continue
                events.push({ type: 'earnings', label: `${symbol} earnings`, date: r.date, when: _earningsWhen(r.hour), impact: 'high' })
            }
        } catch (err) {
            logger.warn(LOG, `earnings lookup failed for ${symbol}:`, err.message)
        }
    }

    // Fed / macro — market-wide, so it applies to every asset class. Drop low-impact noise.
    try {
        const fed = await fetchFed({ days: HORIZON_DAYS })
        for (const e of (Array.isArray(fed) ? fed : [])) {
            if (e?.impact === 'low') continue
            events.push({ type: e.kind === 'fomc' ? 'fomc' : 'macro', label: e.event, date: e.date, when: 'timed', time: e.time ?? null, impact: e.impact ?? 'medium' })
        }
    } catch (err) {
        logger.warn(LOG, 'fed/macro lookup failed:', err.message)
    }

    return events.sort((a, b) => String(a.date).localeCompare(String(b.date)))
}
