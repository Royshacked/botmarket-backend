import fs from 'fs'
import path from 'path'
import { logger } from './logger.service.js'


// NOTE: parsing JSON out of an LLM reply lives in ONE place —
// monitoring/monitorUtils.js `extractFirstJSON`. Don't add a second parser here.


export function isCacheFresh(lastFetchedAt, cacheTimeMs = 5 * 60 * 1000) {
    if (!lastFetchedAt) return false
    return Date.now() - lastFetchedAt < cacheTimeMs
}


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


function _itemsFilePath(type, name) {
    return path.join(path.resolve(`./data/${type}`), `${name}.json`)
}
