// Federal Reserve / macro events provider, backed by FRED (Federal Reserve Bank
// of St. Louis) — a free API. Feeds the Axl Radar "Fed" tab with upcoming
// high-impact US macro data releases + FOMC rate decisions.
//
// FREE-PLAN NOTES:
//  - FRED is free (just needs FRED_API_KEY) and has no forecasts/actuals — it's
//    a schedule of *when* each indicator prints, not consensus estimates. Paid
//    providers (FMP/Finnhub economic-calendar) add forecast/actual columns.
//  - Release IDs below were verified against the live API. FOMC decisions are
//    NOT in FRED's release feed (release 101 reports every calendar day), so
//    meeting dates come from the static schedule — update it annually.

import dotenv from 'dotenv'
import axios from 'axios'
import { logger } from '../services/logger.service.js'
import { createTtlCache } from '../services/ttlCache.util.js'

dotenv.config()

const FRED_API_KEY = process.env.FRED_API_KEY
const BASE = 'https://api.stlouisfed.org/fred'

// Curated high-impact US macro data releases: FRED release_id → display meta.
// `time` is the standard US release time (ET) — a stable convention, since FRED
// only carries the date. `desc` is a hand-written one-liner (shown on hover).
const MACRO_RELEASES = {
    50:  { event: 'Employment Situation (Jobs)', impact: 'high',   time: '8:30a',  desc: 'Monthly jobs added + unemployment rate (NFP)' },
    10:  { event: 'CPI (Inflation)',             impact: 'high',   time: '8:30a',  desc: 'Monthly change in consumer prices' },
    54:  { event: 'PCE / Personal Income',       impact: 'high',   time: '8:30a',  desc: "Fed's preferred inflation gauge + income/spending" },
    53:  { event: 'GDP',                         impact: 'high',   time: '8:30a',  desc: 'Quarterly economic output growth' },
    46:  { event: 'PPI',                         impact: 'medium', time: '8:30a',  desc: 'Monthly change in wholesale/producer prices' },
    192: { event: 'JOLTS (Job Openings)',        impact: 'medium', time: '10:00a', desc: 'Job openings, hires & quits' },
    9:   { event: 'Retail Sales',                impact: 'medium', time: '8:30a',  desc: 'Monthly change in retail spending' },
    27:  { event: 'Housing Starts',              impact: 'low',    time: '8:30a',  desc: 'New residential construction (starts & permits)' },
    180: { event: 'Jobless Claims',              impact: 'low',    time: '8:30a',  desc: 'Weekly new unemployment filings' },
}

// FOMC rate-decision dates (announcement day) — federalreserve.gov 2026 schedule.
// Update this list each year when the Fed publishes the next calendar.
const FOMC_DATES = [
    '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
    '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
]

// The window shifts slowly, so a few-hours cache is plenty.
const _cache = createTtlCache({ ttlMs: 6 * 60 * 60 * 1000, max: 10 }) // "from|to" -> events[]

function _isoOffset(days) {
    return new Date(Date.now() + days * 864e5).toISOString().slice(0, 10)
}

async function _releaseDates(releaseId, from, to) {
    const url = `${BASE}/release/dates?release_id=${releaseId}&api_key=${FRED_API_KEY}`
              + `&file_type=json&realtime_start=${from}&realtime_end=${to}`
              + `&include_release_dates_with_no_data=true&sort_order=asc&limit=40`
    const res = await axios.get(url)
    return Array.isArray(res.data?.release_dates) ? res.data.release_dates.map(d => d.date) : []
}

// Merge curated data-release entries with the in-window FOMC decision dates,
// sorted soonest-first. Pure — extracted so the assembly logic is unit-testable.
export function _assembleFedEvents(releaseEntries, from, to, fomcDates = FOMC_DATES) {
    const fomc = fomcDates
        .filter(d => d >= from && d <= to)
        .map(date => ({
            date, event: 'FOMC Rate Decision', impact: 'high', kind: 'fomc',
            time: '2:00p', desc: 'Fed interest-rate decision + policy statement',
        }))
    return [...releaseEntries, ...fomc].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Upcoming US macro / Fed events over the next `days`, as
 * [{ date, event, impact, kind }] sorted soonest-first. Merges curated FRED data
 * releases with the static FOMC decision schedule. Cached 6h per window.
 */
export async function fetchFedEvents({ days = 45 } = {}) {
    if (!FRED_API_KEY) {
        logger.warn('FRED_API_KEY is not set — Fed calendar unavailable')
        return []
    }

    const from = _isoOffset(0)
    const to   = _isoOffset(days)
    const key  = `${from}|${to}`

    const cached = _cache.get(key)
    if (cached) return cached

    try {
        const ids = Object.keys(MACRO_RELEASES)
        const perRelease = await Promise.all(ids.map(async (id) => {
            try {
                const dates = await _releaseDates(id, from, to)
                return dates.map(date => ({ date, ...MACRO_RELEASES[id], kind: 'data' }))
            } catch (err) {
                logger.warn('FRED release fetch failed', id, err.message)
                return []
            }
        }))

        const events = _assembleFedEvents(perRelease.flat(), from, to)

        _cache.set(key, events)
        return events
    } catch (err) {
        logger.error('Error getting Fed events', err)
        return []
    }
}
