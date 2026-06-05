import { fetchGNews } from '../../providers/gnews.provider.js'
import { filterService } from '../../services/model.filter.service.js'
import { getCompanyName } from '../../providers/yahoofinance.provider.js'
import { isCacheFresh, loadItemsFromFile, saveItemsToFile } from '../../services/util.service.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[newsFeed]'
const CACHE_TYPE = 'news-feed'
const CACHE_NAME = 'feed'
const INTERVAL_MS    = 30 * 60 * 1000
const WINDOW_MS      = 24 * 60 * 60 * 1000
const SYMBOL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const SYMBOL_CACHE_TTL_MS = 15 * 60 * 1000   // per-symbol news is cached for 15 min
const FETCH_QUERY = 'stock market OR earnings OR Fed OR inflation OR economy OR trade'
const FETCH_MAX = 20

let _cache = []
const _clients = new Set()

// Two-phase per-symbol caches (TTL window), so the UI can render articles before
// the slow LLM step finishes:
//   raw      — resolved company + GNews, no LLM (phase 1, fast)
//   enriched — raw passed through the OpenAI relevance filter + sentiment (phase 2)
const _symbolRawCache    = new Map()   // symbol → { articles, fetchedAt }
const _symbolCache       = new Map()   // symbol → { articles, fetchedAt }
// symbol → in-flight Promise — collapses concurrent requests for the same symbol
const _rawInflight       = new Map()
const _sentimentInflight = new Map()

export const newsFeedService = {
    get,
    getForSymbolRaw,
    getForSymbolSentiment,
    start,
    addClient,
    removeClient,
}

function addClient(res) { _clients.add(res) }
function removeClient(res) { _clients.delete(res) }

function _pushToClients() {
    if (_clients.size === 0) return
    const payload = `data: ${JSON.stringify(_cache)}\n\n`
    for (const res of _clients) res.write(payload)
}

function get() { return _cache }

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
        const loaded   = await loadItemsFromFile(CACHE_TYPE, CACHE_NAME)
        const existing = loaded.ok && Array.isArray(loaded.data?.items) ? loaded.data.items : []

        const from     = new Date(Date.now() - WINDOW_MS).toISOString()
        const raw      = await fetchGNews({ query: FETCH_QUERY, from, max: FETCH_MAX })
        const incoming = Array.isArray(raw?.articles) ? raw.articles.map(_mapArticle).filter(_isValid) : []

        const existingKeys = new Set(existing.map(_articleKey))
        const newArticles  = incoming.filter(a => !existingKeys.has(_articleKey(a)))
        const filteredNew  = newArticles.length > 0 ? await filterService.filterNews(newArticles) : []

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

// ─── Phase 1: raw articles (fast, no LLM) ──────────────────────────────────────
async function getForSymbolRaw(symbol, queryHint = '') {
    const key = (symbol ?? '').trim().toUpperCase()
    if (!key) return []

    const cached = _symbolRawCache.get(key)
    if (cached && Date.now() - cached.fetchedAt < SYMBOL_CACHE_TTL_MS) {
        logger.info(LOG, 'symbol raw cache hit', { symbol: key, count: cached.articles.length })
        return cached.articles
    }

    // Collapse concurrent misses (e.g. rapid re-clicks) into one fetch
    if (_rawInflight.has(key)) return _rawInflight.get(key)

    const work = _fetchSymbolRaw(key, queryHint)
        .then(articles => {
            _symbolRawCache.set(key, { articles, fetchedAt: Date.now() })
            logger.info(LOG, 'symbol raw cached', { symbol: key, count: articles.length })
            return articles
        })
        .finally(() => _rawInflight.delete(key))

    _rawInflight.set(key, work)
    return work
}

async function _fetchSymbolRaw(symbol, queryHint) {
    // Resolve the company name (prefer the caller's hint unless it's just the raw ticker)
    let query = queryHint?.trim() ?? ''
    if (!query || /^[A-Z]{1,6}$/.test(query)) {
        query = await getCompanyName(symbol).catch(() => symbol)
    }

    const cleaned = _cleanCompanyName(query)
    const from    = new Date(Date.now() - SYMBOL_WINDOW_MS).toISOString()
    const raw     = await fetchGNews({ query: cleaned, from, max: 10 })
    return Array.isArray(raw?.articles) ? raw.articles.map(_mapArticle).filter(_isValid) : []
}

// ─── Phase 2: relevance filter + sentiment (LLM) ───────────────────────────────
async function getForSymbolSentiment(symbol, queryHint = '') {
    const key = (symbol ?? '').trim().toUpperCase()
    if (!key) return []

    const cached = _symbolCache.get(key)
    if (cached && Date.now() - cached.fetchedAt < SYMBOL_CACHE_TTL_MS) {
        logger.info(LOG, 'symbol sentiment cache hit', { symbol: key, count: cached.articles.length })
        return cached.articles
    }

    if (_sentimentInflight.has(key)) return _sentimentInflight.get(key)

    const work = (async () => {
        const raw      = await getForSymbolRaw(key, queryHint)   // reuses the raw cache
        const enriched = raw.length > 0 ? await filterService.filterNews(raw) : []
        _symbolCache.set(key, { articles: enriched, fetchedAt: Date.now() })
        logger.info(LOG, 'symbol sentiment cached', { symbol: key, count: enriched.length })
        return enriched
    })().finally(() => _sentimentInflight.delete(key))

    _sentimentInflight.set(key, work)
    return work
}

function _cleanCompanyName(name) {
    return name
        .replace(/,?\s*(Inc\.|Incorporated|Corp\.|Corporation|Ltd\.|Limited|LLC|Co\.|Company|Group|Holdings?|PLC|N\.V\.|S\.A\.)\s*$/i, '')
        .trim()
}

function _filterRecent(items) {
    const cutoff = Math.floor((Date.now() - WINDOW_MS) / 1000)
    return items.filter(item => item.datetime >= cutoff)
}

function _mapArticle(item) {
    const publishedMs = Date.parse(item?.publishedAt ?? '')
    return {
        datetime: Number.isFinite(publishedMs) ? Math.floor(publishedMs / 1000) : NaN,
        headline: typeof item?.title === 'string' ? item.title.trim() : '',
        summary:  typeof item?.description === 'string' ? item.description : '',
        url:      item?.url    ?? '',
        image:    item?.image  ?? '',
        source:   item?.source?.name ?? '',
        id:       item?.id     ?? null,
        category: 'markets',
        related:  '',
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
