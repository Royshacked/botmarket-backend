import fs from 'fs'
import path from 'path'

export function makeId(length = 5) {
	var txt = ''
	var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
	for (let i = 0; i < length; i++) {
		txt += possible.charAt(Math.floor(Math.random() * possible.length))
	}
	return txt
}

export function getStartOfTodayUTC() {
	const now = new Date();
	return Date.UTC(
	  now.getUTCFullYear(),
	  now.getUTCMonth(),
	  now.getUTCDate()
	) / 1000; // convert to seconds
}

export function cleanJSON(text) {
	return text
	  .replace(/```json/g, '')
	  .replace(/```/g, '')
	  .trim();
}

export function isCacheFresh(entry, cacheTimeMs = 5 * 60 * 1000) {
	if (!entry || !entry.lastFetchedAt) return false;
	return Date.now() - entry.lastFetchedAt < cacheTimeMs;
}

export async function saveToFile(name,data) {
    try {
        const dir = path.resolve('./data')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
        console.error(`Error saving ${name} to file`, err)
    }
}


export async function loadFromFile(name) {
    try {
        const filePath = path.resolve('./data', `${name}.json`)
        if (!fs.existsSync(filePath)) return []
        const raw = fs.readFileSync(filePath, 'utf8')
        if (!raw) return []
        return JSON.parse(raw)
    } catch (err) {
        console.error(`Error loading ${name} from file`, err)
        return []
    }
}

export function filterTodaysNewsFeed(data) {
    console.log("data:",typeof data)
    const startOfTodayUTC = getStartOfTodayUTC()
    return data.filter(item => item.datetime >= startOfTodayUTC)
}


export async function deduplicateNewsFeed(data, destination) {
    const news = await loadFromFile(destination)
    const today = filterTodaysNewsFeed(news)
    if(today.length === 0) return data

    const unique = data.filter(item => !today.some(todayItem => todayItem.datetime === item.datetime && todayItem.headline === item.headline))
    return unique
}


function _formatYyyyMmDd(date) {
    return date.toISOString().slice(0, 10)
}

export function oneMonthAgoToTodayRange() {
    const to = new Date()
    const from = new Date(to)
    from.setMonth(from.getMonth() - 1)
    return { from: _formatYyyyMmDd(from), to: _formatYyyyMmDd(to) }
}


function _extractFirstJsonObject(text) {
    if (!text) return null
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return null
    return text.slice(start, end + 1)
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

export function isValidUserIntentObject(obj) {
    if (!obj || typeof obj !== 'object') return false
    if (obj.analysisType !== 'news') return false
    if (obj.ticker != null && typeof obj.ticker !== 'string') return false
    if (obj.assetName != null && typeof obj.assetName !== 'string') return false
    return true
}

export function isValidAnalysisObject(obj) {
    if (!obj || typeof obj !== 'object') return false
    if (typeof obj.newsSummary !== 'string') return false
    if (typeof obj.sentiment !== 'string') return false
    if (!Array.isArray(obj.positiveDrivers)) return false
    if (!Array.isArray(obj.negativeRisks)) return false
    if (!Array.isArray(obj.keyEvents)) return false
    if (!Array.isArray(obj.whatToWatchNext)) return false
    if (!obj.possibleMarketReaction || typeof obj.possibleMarketReaction !== 'object') return false
    if (typeof obj.possibleMarketReaction.bullishCase !== 'string') return false
    if (typeof obj.possibleMarketReaction.bearishCase !== 'string') return false
    if (typeof obj.confidence !== 'string') return false
    if (typeof obj.limitation !== 'string') return false
    return true
}

export async function saveCandlesToFile(candles, ticker , options) {
    const letter = options.timeSpan.charAt(0).toUpperCase()
    
    const dir = path.resolve(`./data/candles/${ticker}/${options.timeSpan}`)
    if(!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    if(!candles || !Array.isArray(candles.candles)) return
    try {
        await fs.promises.writeFile(
            path.join(dir, `${options.multiplier}${letter}.json`),
            JSON.stringify(candles, null, 2),
            'utf8'
        )
    } catch (err) {
        console.error(`Error saving candles to file`, err)
    }
}

export async function loadCandlesFromFile(ticker, options) {
    const { timeSpan, multiplier } = options
    const filePath = path.resolve(
        `./data/candles/${ticker}/${timeSpan}/${multiplier}${timeSpan.charAt(0).toUpperCase()}.json`
    )
    if (!fs.existsSync(filePath)) return []
    try{
        const raw = fs.readFileSync(filePath, 'utf8')
        if (!raw) return []
        return JSON.parse(raw)
    } catch (err) {
        console.error(`Error loading candles from file`, err)
        return []
    }
}