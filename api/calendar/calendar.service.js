import { fetchEarningsCalendarByDate, fetchCompanyProfile, fetchIpoCalendar } from '../../providers/finnhub.provider.js'
import { fetchFedEvents } from '../../providers/fred.provider.js'
import { enrichWithProfiles } from '../../services/companyProfile.util.js'

// Calendar business logic (fetch + shape + enrich). The controller stays thin — it just
// calls these and shapes the HTTP response.

export const calendarService = { getEarnings, getFed, getIpo, calendarWeek, enrichCalendarProfiles }

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

async function getEarnings() {
    const { from, to } = calendarWeek()
    const data = await fetchEarningsCalendarByDate(from, to)
    const rows = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : []
    const items = rows
        .map(r => ({
            symbol:           r.symbol,
            date:             r.date,
            time:             r.hour              || null,
            epsEstimated:     r.epsEstimate        ?? null,
            epsActual:        r.epsActual          ?? null,
            revenueEstimated: r.revenueEstimate    ?? null,
        }))
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''))  // chronological → groups by day cleanly
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
    const items = rows
        .map(r => ({
            date:     r.date,
            symbol:   r.symbol || null,
            name:     r.name   || '',
            exchange: r.exchange || '',
            price:    r.price  || null,
            shares:   r.numberOfShares   ?? null,
            value:    r.totalSharesValue ?? null,
            status:   r.status || null,
        }))
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    // Attach logos + fill blank names (many IPO rows carry a name already, so don't clobber
    // it — only fill when Finnhub's calendar left it empty).
    await enrichWithProfiles(items, { overwriteName: false })
    return { items }
}
