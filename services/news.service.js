import { fetchGNews } from '../providers/gnews.provider.js'
import { isCacheFresh, loadItemsFromFile, saveItemsToFile } from './util.service.js'
import { mapGNewsArticle, isValidArticle, mergeDedupedArticles } from './newsArticle.service.js'

const CACHE_TTL_MS = 3_600_000
const FETCH_LIMIT = 20
const CATEGORIES = new Set(['global', 'markets', 'sectors', 'companies'])

export const newsService = {
    getOrFetch,
}

/**
 * @param {string} category
 * @param {string} subject
 * @returns {{ type: string, name: string }}
 */
function storePath(category, subject) {
    return {
        type: `news/${category}`,
        name: _sanitizeFileSegment(subject),
    }
}

/**
 * @param {{ category: string, subject: string, query: string, refresh?: boolean }} opts
 * @returns {Promise<{ articles: NewsArticle[], meta: object }>}
 */
async function getOrFetch({ category, subject, query, refresh = false }) {
    const cat = _requireCategory(category)
    const subj = _requireNonEmpty(subject, 'subject')
    const searchQuery = _requireNonEmpty(query, 'query')

    const store = storePath(cat, subj)
    const cache = await _loadEnvelope(store)
    const fresh =
        !refresh && isCacheFresh(cache.lastFetchedAt, CACHE_TTL_MS)

    if (fresh) {
        return _result(_sortByDatetimeDesc(cache.items), {
            category: cat,
            subject: subj,
            query: cache.query || searchQuery,
            cached: true,
            count: cache.items.length,
        })
    }

    const from =
        cache.lastFetchedAt > 0
            ? new Date(cache.lastFetchedAt).toISOString()
            : _oneMonthAgoISO()
    const to = new Date().toISOString()

    const { articles: incoming, meta: fetchMeta } = await fetchFromGNews({
        query: searchQuery,
        from,
        to,
        limit: FETCH_LIMIT,
    })

    const { merged } = mergeDedupedArticles(cache.items, incoming)
    const envelope = {
        category: cat,
        subject: subj,
        query: searchQuery,
        lastFetchedAt: Date.now(),
        items: merged,
    }
    await _saveEnvelope(store, envelope)

    return _result(_sortByDatetimeDesc(merged), {
        category: cat,
        subject: subj,
        query: searchQuery,
        cached: false,
        count: merged.length,
        fetched: incoming.length,
        ...fetchMeta,
    })
}

/**
 * @param {{ query: string, from?: string, to?: string, limit?: number }} opts
 * @returns {Promise<{ articles: NewsArticle[], meta: object }>}
 */
async function fetchFromGNews({ query, from, to, limit = FETCH_LIMIT }) {
    const searchQuery = _requireNonEmpty(query, 'query')
    const raw = await fetchGNews({
        query: searchQuery,
        from,
        to,
        max: limit,
    })
    const rawArticles = Array.isArray(raw?.articles) ? raw.articles : []
    const articles = rawArticles.map(mapGNewsArticle).filter(isValidArticle)

    return _result(articles, {
        query: searchQuery,
        from,
        to,
        count: articles.length,
        totalArticles: raw?.totalArticles ?? 0,
    })
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

/** @param {{ type: string, name: string }} store @returns {Promise<NewsEnvelope>} */
async function _loadEnvelope(store) {
    const loaded = await loadItemsFromFile(store.type, store.name)
    return _normalizeEnvelope(loaded.ok ? loaded.data : null)
}

/** @param {{ type: string, name: string }} store @param {NewsEnvelope} envelope */
async function _saveEnvelope(store, envelope) {
    const payload = {
        ...envelope,
        items: (Array.isArray(envelope.items) ? envelope.items : []).filter(
            isValidArticle
        ),
        lastFetchedAt: envelope.lastFetchedAt ?? Date.now(),
    }
    const saved = await saveItemsToFile(store.type, store.name, payload)
    if (!saved.ok) {
        throw new Error(
            `Failed to save ${store.type}/${store.name}: ${saved.error?.message}`
        )
    }
    return payload
}

/** @param {unknown} raw @returns {NewsEnvelope} */
function _normalizeEnvelope(raw) {
    const empty = {
        category: '',
        subject: '',
        query: '',
        lastFetchedAt: 0,
        items: [],
    }
    if (raw == null) return empty
    if (raw && typeof raw === 'object' && Array.isArray(raw.items)) {
        let category = ''
        if (typeof raw.category === 'string') {
            category = raw.category
        } else if (typeof raw.kind === 'string') {
            category = raw.kind === 'company' ? 'companies' : raw.kind
        }
        return {
            category,
            subject: typeof raw.subject === 'string' ? raw.subject : '',
            query: typeof raw.query === 'string' ? raw.query : '',
            lastFetchedAt: Number(raw.lastFetchedAt) || 0,
            items: raw.items.filter(isValidArticle),
        }
    }
    return empty
}

function _sortByDatetimeDesc(items) {
    return [...items].sort((a, b) => b.datetime - a.datetime)
}

function _oneMonthAgoISO() {
    const d = new Date()
    d.setMonth(d.getMonth() - 1)
    return d.toISOString()
}

function _sanitizeFileSegment(value) {
    return (
        String(value)
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 64) || 'UNKNOWN'
    )
}

function _requireNonEmpty(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${field} is required`)
    }
    return value.trim()
}

function _requireCategory(category) {
    const normalized = _normalizeCategory(category)
    if (!CATEGORIES.has(normalized)) {
        throw new Error(`category must be one of: ${[...CATEGORIES].join(', ')}`)
    }
    return normalized
}

function _normalizeCategory(category) {
    const c = _requireNonEmpty(category, 'category').toLowerCase()
    if (c === 'company') return 'companies'
    return c
}

function _result(articles, meta = {}) {
    return {
        articles: Array.isArray(articles) ? articles : [],
        meta,
    }
}
