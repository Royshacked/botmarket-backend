import fs from 'fs'

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
	return Date.now() - entry.lastFetchedAt < cacheTime;
}

export async function saveToFile(name,data) {
    fs.writeFile(`./data/${name}.json`, JSON.stringify(data, null, 2), (err) => {
        if (err) {
            console.error(`Error saving ${name} to file`, err)
        }
    })
}


export async function loadFromFile(name) {
    const data = fs.readFile(`./data/${name}.json`, 'utf8', (err, data) => {
        if (err) {
            console.error(`Error loading ${name} from file`, err)
            return []
        }
        return JSON.parse(data)
    })
    if(!data) return []
    return JSON.parse(data)
}

export function filterTodaysNewsFeed(data) {
    const startOfTodayUTC = getStartOfTodayUTC()
    return data.filter(item => item.datetime >= startOfTodayUTC)
}


export function deduplicateNewsFeed(data, destination) {
    const news = loadFromFile(destination)
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
