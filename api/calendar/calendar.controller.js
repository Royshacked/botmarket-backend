import { calendarService, calendarWeek, enrichCalendarProfiles } from './calendar.service.js'
import { makeHandle } from '../_shared/handle.util.js'

const LOG    = '[calendar:controller]'
const handle = makeHandle(LOG)

// Re-exported for unit tests (the logic now lives in calendar.service).
export const _calendarWeek = calendarWeek
export const _enrichWithProfiles = enrichCalendarProfiles

// Three reads over paid providers. A provider's failure (a Finnhub 429 rides on `err.status`) is
// OUR 500, not the client's 429 — the global handler answers only a status we minted.
export const getEarnings = handle('getEarnings', async (req, res) => { res.json(await calendarService.getEarnings()) })
export const getFed      = handle('getFed',      async (req, res) => { res.json(await calendarService.getFed()) })
export const getIpo      = handle('getIpo',      async (req, res) => { res.json(await calendarService.getIpo()) })
