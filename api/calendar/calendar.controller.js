import { fetchEarningsCalendarByDate, fetchFdaCalendar } from '../../providers/finnhub.provider.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[calendar:controller]'

// Days until next trading day, indexed by getDay() (0=Sun … 6=Sat).
// Weekend days (Sat/Sun) and Friday all land on Monday.
const _TRADING_DAY_SHIFT = [1, 1, 1, 1, 1, 3, 2]

function _nextTradingDay() {
    const d = new Date()
    d.setDate(d.getDate() + _TRADING_DAY_SHIFT[d.getDay()])
    return d.toISOString().slice(0, 10)
}

export async function getEarnings(req, res) {
    try {
        const date = _nextTradingDay()
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
        res.json({ date, items })
    } catch (err) {
        logger.error(LOG, 'getEarnings failed', err)
        res.status(500).json({ error: 'Failed to fetch earnings calendar' })
    }
}

export async function getFda(req, res) {
    try {
        const date = _nextTradingDay()
        const items = await fetchFdaCalendar(date, date)
        res.json({ date, items })
    } catch (err) {
        logger.error(LOG, 'getFda failed', err)
        res.status(500).json({ error: 'Failed to fetch FDA calendar' })
    }
}
