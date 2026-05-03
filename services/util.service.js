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

export function isCacheFresh(entry, cacheTime) {
	if (!entry || !entry.lastFetchedAt) return false;
	return Date.now() - entry.lastFetchedAt < cacheTime;
}

export function saveToFile(name,data) {
    fs.writeFileSync(`./data/${name}.json`, JSON.stringify(data, null, 2))
}


export function loadFromFile(name) {
    const data = fs.readFileSync(`./data/${name}.json`, 'utf8')
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
