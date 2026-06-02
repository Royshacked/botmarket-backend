import { fetchGNews } from '../../providers/gnews.provider.js'
import { filterService } from '../../services/model.filter.service.js'
import { isCacheFresh, loadItemsFromFile, saveItemsToFile } from '../../services/util.service.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[newsFeed]'
const CACHE_TYPE = 'news-feed'
const CACHE_NAME = 'feed'
const INTERVAL_MS = 30 * 60 * 1000
const WINDOW_MS = 24 * 60 * 60 * 1000 // show articles from last 24h
const FETCH_QUERY = 'stock market OR earnings OR Fed OR inflation OR economy OR trade'
const FETCH_MAX = 20

let _cache = []
const _clients = new Set()

export const newsFeedService = {
    get,
    start,
    addClient,
    removeClient,
}

function addClient(res) {
    _clients.add(res)
}

function removeClient(res) {
    _clients.delete(res)
}

function _pushToClients() {
    if (_clients.size === 0) return
    const payload = `data: ${JSON.stringify(_cache)}\n\n`
    for (const res of _clients) {
        res.write(payload)
    }
}

function get() {
    return _cache
}

export async function start() {
    const loaded = await loadItemsFromFile(CACHE_TYPE, CACHE_NAME)
    if (loaded.ok) {
        const items = Array.isArray(loaded.data?.items) ? loaded.data.items : []
        _cache = _filterRecent(items)

        if (_cache.length > 0 && isCacheFresh(loaded.data?.lastFetchedAt, INTERVAL_MS)) {
            logger.info(LOG, 'loaded from file cache', { count: _cache.length })
            setInterval(_refresh, INTERVAL_MS)
            return
        }
    }

    await _refresh()
    setInterval(_refresh, INTERVAL_MS)
}

async function _refresh() {
    try {
        const loaded = await loadItemsFromFile(CACHE_TYPE, CACHE_NAME)
        const existing = loaded.ok && Array.isArray(loaded.data?.items) ? loaded.data.items : []
        const lastFetchedAt = loaded.ok ? (loaded.data?.lastFetchedAt ?? 0) : 0

        // always fetch the full 24h window — dedup below handles skipping already-seen articles
        const from = new Date(Date.now() - WINDOW_MS).toISOString()

        const raw = await fetchGNews({ query: FETCH_QUERY, from, max: FETCH_MAX })
        const incoming = Array.isArray(raw?.articles) ? raw.articles.map(_mapArticle).filter(_isValid) : []

        const existingKeys = new Set(existing.map(_articleKey))
        const newArticles = incoming.filter(a => !existingKeys.has(_articleKey(a)))

        const filteredNew = newArticles.length > 0 ? await filterService.filterNews(newArticles) : []

        const merged = _dedupeByKey([...existing, ...filteredNew])
        const recent = _filterRecent(merged)

        await saveItemsToFile(CACHE_TYPE, CACHE_NAME, { items: recent, lastFetchedAt: Date.now() })
        _cache = recent
        _pushToClients()

        logger.info(LOG, 'refreshed', { total: recent.length, newFiltered: filteredNew.length })
    } catch (err) {
        logger.error(LOG, 'refresh failed', err)
    }
}

// keep articles from the last 24 hours
function _filterRecent(items) {
    const cutoff = Math.floor((Date.now() - WINDOW_MS) / 1000) // in unix seconds
    return items.filter(item => item.datetime >= cutoff)
}

function _mapArticle(item) {
    const publishedMs = Date.parse(item?.publishedAt ?? '')
    return {
        datetime: Number.isFinite(publishedMs) ? Math.floor(publishedMs / 1000) : NaN,
        headline: typeof item?.title === 'string' ? item.title.trim() : '',
        summary: typeof item?.description === 'string' ? item.description : '',
        url: item?.url ?? '',
        image: item?.image ?? '',
        source: item?.source?.name ?? '',
        id: item?.id ?? null,
        category: 'markets',
        related: '',
    }
}

function _isValid(item) {
    return (
        item &&
        Number.isFinite(item.datetime) &&
        typeof item.headline === 'string' &&
        item.headline.length > 0
    )
}

function _articleKey(item) {
    return item?.url || `${item?.datetime}:${item?.headline}`
}

function _dedupeByKey(articles) {
    const seen = new Set()
    return articles.filter(a => {
        const key = _articleKey(a)
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}
