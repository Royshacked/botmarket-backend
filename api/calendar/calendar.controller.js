import { fetchEarningsCalendarByDate, fetchCompanyProfile, fetchIpoCalendar } from '../../providers/finnhub.provider.js'
import { fetchFedEvents } from '../../providers/fred.provider.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[calendar:controller]'

// Which day's calendar to show, as a day offset indexed by getDay() (0=Sun … 6=Sat):
// today on weekdays; on the weekend, tomorrow (Sat→Sun, Sun→Mon).
const _CALENDAR_DAY_SHIFT = [1, 0, 0, 0, 0, 0, 1]

function _calendarDay() {
    const d = new Date()
    d.setDate(d.getDate() + _CALENDAR_DAY_SHIFT[d.getDay()])
    return d.toISOString().slice(0, 10)
}

// Attach company name + logo to each row. Concurrency-capped so a busy earnings
// day doesn't burst past Finnhub's rate limit; cached profiles return instantly.
// `fetchProfile` is injectable for testing.
export async function _enrichWithProfiles(items, fetchProfile = fetchCompanyProfile, concurrency = 5) {
    let idx = 0
    async function worker() {
        while (idx < items.length) {
            const item = items[idx++]
            const { name, logo } = await fetchProfile(item.symbol)
            item.name = name
            item.logo = logo
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
    return items
}

export async function getEarnings(req, res) {
    try {
        const date = _calendarDay()
        const data = await fetchEarningsCalendarByDate(date, date)
        const rows = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : []
        const items = rows.map(r => ({
            symbol:           r.symbol,
            date:             r.date,
            time:             r.hour              || null,
            epsEstimated:     r.epsEstimate        ?? null,
            epsActual:        r.epsActual          ?? null,
            revenueEstimated: r.revenueEstimate    ?? null,
        }))
        await _enrichWithProfiles(items)
        res.json({ date, items })
    } catch (err) {
        logger.error(LOG, 'getEarnings failed', err)
        res.status(500).json({ error: 'Failed to fetch earnings calendar' })
    }
}

export async function getFed(req, res) {
    try {
        const items = await fetchFedEvents({ days: 45 })
        res.json({ items })
    } catch (err) {
        logger.error(LOG, 'getFed failed', err)
        res.status(500).json({ error: 'Failed to fetch Fed calendar' })
    }
}

export async function getIpo(req, res) {
    try {
        const from = new Date().toISOString().slice(0, 10)
        const to   = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10)
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
        res.json({ items })
    } catch (err) {
        logger.error(LOG, 'getIpo failed', err)
        res.status(500).json({ error: 'Failed to fetch IPO calendar' })
    }
}
