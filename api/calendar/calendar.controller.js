import { getEarningsCalendarRaw } from '../../providers/fmp.provider.js'
import { fetchFdaCalendar } from '../../providers/finnhub.provider.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[calendar:controller]'

function _nextTradingDay() {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    // Skip weekends — Saturday → Monday, Sunday → Monday
    const day = d.getDay()
    if (day === 6) d.setDate(d.getDate() + 2)
    else if (day === 0) d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
}

export async function getEarnings(req, res) {
    try {
        const date = _nextTradingDay()
        const rows = await getEarningsCalendarRaw(date, date)
        const items = rows.map(r => ({
            symbol:       r.symbol,
            date:         r.date,
            time:         r.time || null,
            epsEstimated: r.epsEstimated ?? null,
            epsActual:    r.epsActual    ?? null,
            revenueEstimated: r.revenueEstimated ?? null,
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
