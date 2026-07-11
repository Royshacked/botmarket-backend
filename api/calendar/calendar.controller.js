import { calendarService, calendarWeek, enrichCalendarProfiles } from './calendar.service.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[calendar:controller]'

// Re-exported for unit tests (the logic now lives in calendar.service).
export const _calendarWeek = calendarWeek
export const _enrichWithProfiles = enrichCalendarProfiles

export async function getEarnings(req, res) {
    try {
        res.json(await calendarService.getEarnings())
    } catch (err) {
        logger.error(LOG, 'getEarnings failed', err)
        res.status(500).json({ error: 'Failed to fetch earnings calendar' })
    }
}

export async function getFed(req, res) {
    try {
        res.json(await calendarService.getFed())
    } catch (err) {
        logger.error(LOG, 'getFed failed', err)
        res.status(500).json({ error: 'Failed to fetch Fed calendar' })
    }
}

export async function getIpo(req, res) {
    try {
        res.json(await calendarService.getIpo())
    } catch (err) {
        logger.error(LOG, 'getIpo failed', err)
        res.status(500).json({ error: 'Failed to fetch IPO calendar' })
    }
}
