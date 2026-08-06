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
export async function fetchFedEvents({ days = 45, backDays = 0 } = {}) {
    if (!FRED_API_KEY) {
        logger.warn('FRED_API_KEY is not set — Fed calendar unavailable')
        return []
    }

    // `backDays` opens the window BACKWARDS. The Radar tab wants what is coming (the default, 0);
    // the strategy monitor wants what has already landed since it last published, which is the
    // opposite direction over the same feed.
    const from = _isoOffset(-backDays)
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

// ─── What the market has PRICED IN ────────────────────────────────────────────
//
// The macro analogue of a consensus price target: a hard, continuously-updated observable to hold a
// house view AGAINST. The most useful top-down work is not "where will CPI be" — it is "the market
// is pricing X, we think Y, here is why", and that framing needs X to be a number somebody else set.
//
// Breakevens are the free half of that. The market-implied POLICY PATH (fed funds futures / OIS) is
// the other half and has no clean free source, so it is deliberately absent rather than faked — a
// desk quoting a made-up path would be worse than one that admits it cannot see it.
//
// Read as EXPECTATIONS with a caveat: a breakeven is the nominal-minus-real spread, so it carries an
// inflation risk premium and is not a pure forecast. The prompt is told to say so.
const PRICED_IN_SERIES = [
    ['breakeven_5y',   'T5YIE',  '5-year breakeven inflation'],
    ['breakeven_10y',  'T10YIE', '10-year breakeven inflation'],
    ['forward_5y5y',   'T5YIFR', '5y5y forward inflation expectation'],
    ['real_yield_10y', 'DFII10', '10-year TIPS real yield'],
]

// Daily series, so an hour is plenty and it keeps a chatty turn off the wire.
const _pricedInCache = createTtlCache({ ttlMs: 60 * 60 * 1000, max: 4 })

/** Latest observation for one FRED series → { value, date } | null. FRED writes '.' for no print. */
async function _latest(seriesId) {
    const url = `${BASE}/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}`
              + `&file_type=json&sort_order=desc&limit=1`
    const res = await axios.get(url)
    const o   = res.data?.observations?.[0]
    const v   = Number(o?.value)
    return (o?.date && Number.isFinite(v)) ? { value: v, date: o.date } : null
}

/**
 * What the market has priced in, structured → `{ asOf, breakeven_5y, breakeven_10y, forward_5y5y,
 * real_yield_10y }` with each leg `{ value, date }` or null.
 *
 * A leg that fails is null and the rest still return: a partial read is genuinely more useful than
 * none, and a caller can see exactly which number is missing rather than guessing why the whole
 * thing is empty.
 */
export async function getPricedInRaw() {
    if (!FRED_API_KEY) {
        logger.warn('FRED_API_KEY is not set — priced-in levels unavailable')
        return null
    }
    const hit = _pricedInCache.get('latest')
    if (hit) return hit

    const legs = await Promise.all(PRICED_IN_SERIES.map(async ([key, id]) => {
        try { return [key, await _latest(id)] }
        catch (err) { logger.warn('FRED priced-in leg failed', id, err.message); return [key, null] }
    }))
    const out = Object.fromEntries(legs)
    if (Object.values(out).every(v => v === null)) return null   // nothing read → say so, don't ship an empty shell

    out.asOf = legs.map(([, v]) => v?.date).filter(Boolean).sort().at(-1) ?? null
    _pricedInCache.set('latest', out)
    return out
}

/** The same read, LLM-ready. Pure formatter — exported for testing. */
export function formatPricedIn(raw) {
    if (!raw) return 'Market-implied levels unavailable right now — say so rather than substituting your own estimate.'
    const line = ([key, , label]) => {
        const leg = raw[key]
        return leg ? `  ${label.padEnd(36)} ${leg.value.toFixed(2)}%` : `  ${label.padEnd(36)} unavailable`
    }
    return [
        `What the market has PRICED IN (FRED, ${raw.asOf ?? 'latest'}) — the benchmark your view must beat:`,
        ...PRICED_IN_SERIES.map(line),
        '',
        'Breakevens are nominal-minus-real, so they carry an inflation risk premium and are not a pure',
        'forecast. The market-implied POLICY PATH is not available to us — do not state one as fact.',
    ].join('\n')
}

/** What the market has priced in, LLM-ready. Cached 1h. */
export async function getPricedIn() {
    return formatPricedIn(await getPricedInRaw())
}

/**
 * Macro catalysts that have ALREADY LANDED, as plain `YYYY-MM-DD` — the strategy monitor's trigger
 * feed. Backward-looking on purpose: the monitor asks "has anything happened since I last published
 * that contradicts the model", which is a question about the past, not the schedule.
 *
 * High-impact releases and FOMC decisions only. A low-impact print is not a reason to re-author a
 * 3-12 month sector view, and a trigger that fires on everything is one nobody can act on.
 *
 * The default lookback comfortably spans the monitor's own floor (30 days), so no catalyst can slip
 * through the gap between two reviews.
 */
export async function fetchMacroCatalystDates({ backDays = 60 } = {}) {
    const events = await fetchFedEvents({ days: 1, backDays }).catch(() => [])
    return [...new Set(events.filter(e => e?.kind === 'fomc' || e?.impact === 'high').map(e => e.date))].sort()
}
