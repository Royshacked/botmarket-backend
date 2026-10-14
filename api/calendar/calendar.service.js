import { fetchEarningsCalendarByDate, fetchCompanyProfile, peekCompanyProfile, fetchIpoCalendar } from '../../providers/finnhub.provider.js'
import { fetchFedEvents, fetchFedEventsRange } from '../../providers/fred.provider.js'
import { enrichWithProfiles } from '../../services/companyProfile.util.js'
import { mapLimit } from '../../services/concurrency.util.js'
import { createTtlCache } from '../../services/ttlCache.util.js'
import { httpError } from '../../services/httpError.util.js'
import { logger } from '../../services/logger.service.js'

// Calendar business logic (fetch + shape + enrich). The controller stays thin — it just
// calls these and shapes the HTTP response.

export const calendarService = {
    getEarnings, getFed, getIpo, getCounts, getDay,
    calendarWeek, enrichCalendarProfiles, dedupeByDaySymbol, parseRange, parseDate,
}

const LOG = '[calendar:service]'

// Which window the calendar shows = the current trading week. On a weekday that's today →
// this week's Friday; on the weekend it rolls forward to the coming Mon–Fri. Offsets indexed
// by getDay() (0=Sun … 6=Sat): FROM is the window start (today, or the coming Monday on
// Sat/Sun), TO is that week's Friday.
const _WEEK_FROM_SHIFT = [1, 0, 0, 0, 0, 0, 2]
const _WEEK_TO_SHIFT   = [5, 4, 3, 2, 1, 0, 6]

export function calendarWeek(now = new Date()) {
    const day = now.getDay()
    const from = new Date(now); from.setDate(now.getDate() + _WEEK_FROM_SHIFT[day])
    const to   = new Date(now); to.setDate(now.getDate() + _WEEK_TO_SHIFT[day])
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

// Thin wrapper over the shared profile enrichment (keyed on `symbol`). `fetchProfile` is
// injectable for testing.
export async function enrichCalendarProfiles(items, fetchProfile = fetchCompanyProfile, concurrency = 5) {
    return enrichWithProfiles(items, { fetchProfile, concurrency })
}

// Finnhub can report the same ticker twice on one date (re-filed / duplicated rows), which
// renders as a repeated line and breaks the day+symbol identity both calendar surfaces key on.
// Collapse to one row per symbol+date, first-wins, filling any field the first row left blank
// so a sparse duplicate never costs us an estimate. Rows without a symbol pass through
// untouched — they can't collide on identity.
export function dedupeByDaySymbol(items) {
    const seen = new Map()
    const out = []
    for (const item of items) {
        if (!item.symbol) { out.push(item); continue }
        const key = `${item.date}|${item.symbol}`
        const kept = seen.get(key)
        if (!kept) { seen.set(key, item); out.push(item); continue }
        for (const [k, v] of Object.entries(item)) {
            if (kept[k] == null && v != null) kept[k] = v
        }
    }
    return out
}

// One row shape per feed, shared by the week lists and the month calendar.
function earningsItems(rows) {
    return dedupeByDaySymbol(rows.map(r => ({
        symbol:           r.symbol,
        date:             r.date,
        time:             r.hour              || null,
        epsEstimated:     r.epsEstimate        ?? null,
        epsActual:        r.epsActual          ?? null,
        revenueEstimated: r.revenueEstimate    ?? null,
    })))
}

function ipoItems(rows) {
    return dedupeByDaySymbol(rows.map(r => ({
        date:     r.date,
        symbol:   r.symbol || null,
        name:     r.name   || '',
        exchange: r.exchange || '',
        price:    r.price  || null,
        shares:   r.numberOfShares   ?? null,
        value:    r.totalSharesValue ?? null,
        status:   r.status || null,
    })))
}

const byDate = (a, b) => (a.date || '').localeCompare(b.date || '')

async function getEarnings() {
    const { from, to } = calendarWeek()
    const data = await fetchEarningsCalendarByDate(from, to)
    const rows = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : []
    const items = earningsItems(rows).sort(byDate)  // chronological → groups by day cleanly
    await enrichCalendarProfiles(items)
    return { from, to, items }
}

async function getFed() {
    const items = await fetchFedEvents({ days: 45 })
    return { items }
}

async function getIpo() {
    const { from, to } = calendarWeek()
    const rows = await fetchIpoCalendar(from, to)
    const items = ipoItems(rows).sort(byDate)
    // Attach logos + fill blank names (many IPO rows carry a name already, so don't clobber
    // it — only fill when Finnhub's calendar left it empty).
    await enrichWithProfiles(items, { overwriteName: false })
    return { items }
}

// ── The month calendar (the Floor's Calendar desk, 2026-10-14) ───────────────────────────────
//
// Two reads: COUNTS per day for a month grid, and one DAY in full when a date is opened. They
// differ in cost on purpose. A month of earnings is thousands of rows (Oct 2026: 1,500+ by the
// 30th, peak days 350–485), and every row the week list shows costs a profile lookup — fine for a
// week of ~80, ruinous for a month. So the grid gets bare counts, and only an opened day pays for
// names and logos, and even then only for the names worth it.

const MAX_RANGE_DAYS   = 62     // a month view plus its leading/trailing week rows
// Finnhub answers at most this many earnings rows and drops the EARLIEST dates to fit (sampled
// 2026-10-14: an October request started on the 8th). A chunk that comes back full is re-asked
// day by day, so a busy week cannot silently lose its Monday.
const FINNHUB_ROW_CAP  = 1500
const CHUNK_DAYS       = 7
// Live profile lookups an opened day may spend. The rest of the day rides on what the profile
// cache already knows; the biggest names (by revenue estimate) are first in line for the live ones.
const DAY_LIVE_PROFILES = 40

// Raw Finnhub rows per window. An hour is plenty: estimates move, dates rarely do. Empty answers
// are not cached — the provider swallows a failure into an empty list, and an outage must not be
// remembered as a quiet week for an hour.
const _earningsCache = createTtlCache({ ttlMs: 60 * 60 * 1000, max: 128 })

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function addDays(iso, n) {
    const d = new Date(`${iso}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
}

/** A real YYYY-MM-DD, or a 400. (`2026-02-30` is well-formed and still not a date.) */
export function parseDate(value, name = 'date') {
    if (typeof value !== 'string' || !ISO_DATE.test(value) || addDays(value, 0) !== value) {
        throw httpError(400, `${name} must be a date (YYYY-MM-DD)`)
    }
    return value
}

/** `{ from, to }` from a query, inclusive, ordered and at most MAX_RANGE_DAYS long — or a 400. */
export function parseRange(from, to) {
    parseDate(from, 'from')
    parseDate(to, 'to')
    if (from > to) throw httpError(400, 'from must not be after to')
    if (addDays(from, MAX_RANGE_DAYS - 1) < to) throw httpError(400, `range must be at most ${MAX_RANGE_DAYS} days`)
    return { from, to }
}

/** [from, to] split into consecutive windows of at most `size` days. */
export function chunkRange(from, to, size = CHUNK_DAYS) {
    const out = []
    for (let start = from; start <= to; start = addDays(start, size)) {
        const end = addDays(start, size - 1)
        out.push([start, end < to ? end : to])
    }
    return out
}

/** Every Finnhub earnings row in [from, to] — split day by day when a window hits the row cap. */
export async function earningsRowsInRange(from, to, fetchRows = fetchEarningsCalendarByDate) {
    const key = `${from}|${to}`
    const hit = _earningsCache.get(key)
    if (hit) return hit

    const data = await fetchRows(from, to)
    let rows = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : []
    if (rows.length >= FINNHUB_ROW_CAP) {
        if (from === to) {
            logger.warn(LOG, `earnings for ${from} hit Finnhub's ${FINNHUB_ROW_CAP}-row cap — the day may be incomplete`)
        } else {
            const days = chunkRange(from, to, 1).map(([d]) => d)
            rows = (await mapLimit(days, d => earningsRowsInRange(d, d, fetchRows), { concurrency: 2 })).flat()
        }
    }
    if (rows.length) _earningsCache.set(key, rows)
    return rows
}

/**
 * Per-day counts over [from, to]: `{ from, to, days: { 'YYYY-MM-DD': { earnings, fed, ipo, fedHigh? } } }`.
 * `fedHigh` names the day's high-impact Fed releases ('CPI', 'FOMC') and is absent when there are
 * none. Days with nothing are absent. No profile lookups — a count needs none.
 */
async function getCounts(from, to, deps = {}) {
    const {
        earningsRows = earningsRowsInRange,
        fedEvents    = fetchFedEventsRange,
        ipoRows      = fetchIpoCalendar,
    } = deps
    const [earn, fed, ipo] = await Promise.all([
        mapLimit(chunkRange(from, to), ([f, t]) => earningsRows(f, t), { concurrency: 2 }).then(a => a.flat()),
        fedEvents(from, to),
        ipoRows(from, to),
    ])
    const days = {}
    const bump = (date, kind) => {
        if (!date || date < from || date > to) return
        days[date] ??= { earnings: 0, fed: 0, ipo: 0 }
        days[date][kind] += 1
    }
    for (const r of earningsItems(earn)) bump(r.date, 'earnings')
    for (const e of fed)                 bump(e.date, 'fed')
    for (const r of ipoItems(ipo))       bump(r.date, 'ipo')
    // The releases that move the whole market (impact 'high': Jobs, CPI, PCE, GDP, FOMC) are NAMED
    // on their day, not just counted — a CPI morning must stand out from a Jobless Claims one
    // (Roy, 2026-10-14).
    for (const e of fed) {
        if (e.impact !== 'high' || !days[e.date]) continue
        const name = e.short || e.event
        days[e.date].fedHigh ??= []
        if (!days[e.date].fedHigh.includes(name)) days[e.date].fedHigh.push(name)
    }
    return { from, to, days }
}

// Biggest first, by the revenue estimate: the one size signal the calendar row carries. A day of
// 350 names is read from the top, so the top should be the names a trader has heard of.
const byRevenueDesc = (a, b) =>
    (b.revenueEstimated ?? -1) - (a.revenueEstimated ?? -1) || (a.symbol || '').localeCompare(b.symbol || '')

/**
 * Names + logos for a long list: every cached profile, plus live lookups for the first
 * `liveCap` names the cache did not know. Rows left over keep their symbol and no name.
 */
export async function enrichFromCache(items, {
    peek = peekCompanyProfile, fetchProfile = fetchCompanyProfile, liveCap = DAY_LIVE_PROFILES,
} = {}) {
    const misses = []
    await mapLimit(items, async (item) => {
        const hit = await peek(item.symbol)
        if (hit) { item.name = hit.name; item.logo = hit.logo }
        else misses.push(item)
    }, { concurrency: 10 })
    // mapLimit finishes out of order; the live calls go to the biggest misses, so re-rank them.
    const order = new Map(items.map((it, i) => [it, i]))
    misses.sort((a, b) => order.get(a) - order.get(b))
    await enrichWithProfiles(misses.slice(0, liveCap), { fetchProfile })
    return items
}

/** One date in full: `{ date, earnings, fed, ipo }` — what the calendar's date page lists. */
async function getDay(date, deps = {}) {
    const {
        earningsRows = earningsRowsInRange,
        fedEvents    = fetchFedEventsRange,
        ipoRows      = fetchIpoCalendar,
        enrich       = enrichFromCache,
        enrichIpo    = (items) => enrichWithProfiles(items, { overwriteName: false }),
    } = deps
    const [earn, fed, ipo] = await Promise.all([earningsRows(date, date), fedEvents(date, date), ipoRows(date, date)])
    const earnings = earningsItems(earn).filter(r => r.date === date).sort(byRevenueDesc)
    const ipos     = ipoItems(ipo).filter(r => r.date === date)
    await Promise.all([enrich(earnings), enrichIpo(ipos)])
    return { date, earnings, fed: fed.filter(e => e.date === date), ipo: ipos }
}
