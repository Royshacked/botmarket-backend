import fs from 'fs'
import path from 'path'
import { logger } from './logger.service.js'


export function getStartOfTodayUTC() {
	const now = new Date();
	return Date.UTC(
	  now.getUTCFullYear(),
	  now.getUTCMonth(),
	  now.getUTCDate()
	) / 1000; // convert to seconds
}


export function oneMonthAgoToTodayRange() {
    const to = new Date()
    const from = new Date(to)
    from.setMonth(from.getMonth() - 1)
    return { from: _formatYyyyMmDd(from), to: _formatYyyyMmDd(to) }
}


export function filterTodaysItems(data) {
    const startOfTodayUTC = getStartOfTodayUTC()
    return data.filter(item => item.datetime >= startOfTodayUTC)
}


export async function deduplicateItems(type='', name, data) {
    const loaded = await loadItemsFromFile(type, name)
    const news = _itemsArrayFromLoaded(loaded)
    const today = filterTodaysItems(news)
    if(today.length === 0) return data

    const unique = data.filter(item => !today.some(todayItem => todayItem.datetime === item.datetime && todayItem.headline === item.headline))
    return unique
}


export function cleanJSON(text) {
	return text
	  .replace(/```json/g, '')
	  .replace(/```/g, '')
	  .trim();
}


export function isCacheFresh(lastFetchedAt, cacheTimeMs = 5 * 60 * 1000) {
	// if (!lastFetchedAt) return false;
	return Date.now() - lastFetchedAt < cacheTimeMs;
}


export function safeParseJsonObject(text) {
    const cleaned = cleanJSON(text || '')
    try {
        return JSON.parse(cleaned)
    } catch {
        const extracted = _extractFirstJsonObject(cleaned)
        if (!extracted) return null
        try {
            return JSON.parse(extracted)
        } catch {
            return null
        }
    }
}


/**
 * @param {string} ticker
 * @param {{ timeSpan: string, multiplier: number }} options
 * @param {unknown} data
 * @returns {Promise<{ ok: true } | { ok: false, error: Error }>}
 */
export async function saveCandlesToFile(ticker, options, data) {
    const filePath = candlesFilePath(ticker, options)
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
        return { ok: true }
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        logger.error(`Error saving candles for ${ticker}`, error)
        return { ok: false, error }
    }
}

/**
 * @param {string} ticker
 * @param {{ timeSpan: string, multiplier: number }} options
 * @returns {Promise<
 *   | { ok: true, data: unknown }
 *   | { ok: false, reason: 'missing' | 'empty' | 'parse_error' | 'io_error', data: null, error?: Error }
 * >}
 */
export async function loadCandlesFromFile(ticker, options) {
    const filePath = candlesFilePath(ticker, options)
    try {
        if (!fs.existsSync(filePath)) {
            return { ok: false, reason: 'missing', data: null }
        }
        const raw = await fs.promises.readFile(filePath, 'utf8')
        if (!raw.trim()) {
            return { ok: false, reason: 'empty', data: null }
        }
        return { ok: true, data: JSON.parse(raw) }
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        const reason = error instanceof SyntaxError ? 'parse_error' : 'io_error'
        logger.error(`Error loading candles for ${ticker}`, error)
        return { ok: false, reason, data: null, error }
    }
}

export function candlesFilePath(ticker, { timeSpan, multiplier }) {
    const letter = timeSpan.charAt(0).toUpperCase()
    return path.resolve(
        `./data/candles/${ticker}/${timeSpan}/${multiplier}${letter}.json`
    )
}


/**
 * @param {string} type
 * @param {string} name
 * @param {unknown} data
 * @returns {Promise<{ ok: true } | { ok: false, error: Error }>}
 */
export async function saveItemsToFile(type, name, data) {
    const filePath = _itemsFilePath(type, name)
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
        return { ok: true }
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        logger.error(`Error saving ${name} to file`, error)
        return { ok: false, error }
    }
}

/**
 * @param {string} [type]
 * @param {string} name
 * @returns {Promise<
 *   | { ok: true, data: unknown }
 *   | { ok: false, reason: 'missing' | 'empty' | 'parse_error' | 'io_error', data: null, error?: Error }
 * >}
 */
export async function loadItemsFromFile(type = '', name) {
    const filePath = _itemsFilePath(type, name)
    try {
        if (!fs.existsSync(filePath)) {
            return { ok: false, reason: 'missing', data: null }
        }
        const raw = await fs.promises.readFile(filePath, 'utf8')
        if (!raw.trim()) {
            return { ok: false, reason: 'empty', data: null }
        }
        return { ok: true, data: JSON.parse(raw) }
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        const reason = error instanceof SyntaxError ? 'parse_error' : 'io_error'
        logger.error(`Error loading ${name} from file`, error)
        return { ok: false, reason, data: null, error }
    }
}

/** @param {{ ok: boolean, data?: unknown }} loaded */
export function itemsArrayFromLoaded(loaded) {
    return _itemsArrayFromLoaded(loaded)
}

function _itemsFilePath(type, name) {
    return path.join(path.resolve(`./data/${type}`), `${name}.json`)
}

/** @param {{ ok: boolean, data?: unknown }} loaded */
function _itemsArrayFromLoaded(loaded) {
    if (!loaded?.ok) return []
    const raw = loaded.data
    if (Array.isArray(raw)) return raw
    if (raw && typeof raw === 'object' && Array.isArray(raw.items)) return raw.items
    return []
}



function _formatYyyyMmDd(date) {
    return date.toISOString().slice(0, 10)
}



function _extractFirstJsonObject(text) {
    if (!text) return null
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return null
    return text.slice(start, end + 1)
}

