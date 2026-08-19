/**
 * THE ONE NEWS PIPE — fetch, cache, dedupe. Two consumers: the `news` condition evaluator and Axl's
 * `get_news` tool. Neither knows where an article came from, and that is deliberate.
 *
 * ── TWO SOURCES, SPLIT BY THE QUESTION ───────────────────────────────────────
 * Finnhub answers anything that has a KEY: a ticker (`companies`) or the front page (`headlines`).
 * Its company feed is symbol-keyed, so a read for NVDA returns Nvidia's own coverage. GNews answers
 * anything that only has WORDS (`topic`: "OPEC", "semiconductors", "Federal Reserve") — a text index
 * is the only thing that can, and it is also why it is the wrong tool for a company: searching
 * "Nvidia" returns competitors' stories that merely mention it. A company read still falls back to
 * GNews when Finnhub has nothing, which is what keeps non-US names and crypto answerable.
 *
 * ── A FAILED FETCH DOES NOT DISCARD A WARM CACHE ─────────────────────────────
 * If the provider errors and we hold articles, those are served with `meta.stale`. An hour-old
 * headline is a far better answer than an error, and the digest dates every item anyway.
 */
import { fetchGNews } from '../providers/gnews.provider.js'
import { fetchCompanyNews, fetchGeneralNews } from '../providers/finnhub.provider.js'
import { logger } from './logger.service.js'
import { isCacheFresh, loadItemsFromFile, saveItemsToFile } from './util.service.js'
import { mapGNewsArticle, mapFinnhubArticle, isValidArticle, mergeDedupedArticles } from './newsArticle.service.js'

/**
 * How long each shelf stays warm — one TTL per KIND of read, not one for the file.
 *
 * The front page is the only feed a reader notices going stale: "what's the news today" is a question
 * about right now, and an hour-old top-stories list answers it with this morning. A company or topic
 * shelf is a rolling archive — an hour-old copy answers just as well, every item is dated in the
 * digest, and the incremental fetch means the hour costs one call rather than a re-download.
 *
 * Raising a number here is free; lowering one spends provider quota on every user who asks.
 */
export const CACHE_TTL_MS = {
    companies:  3_600_000,   // 1 hour
    topic:      3_600_000,   // 1 hour
    headlines:    900_000,   // 15 minutes — the front page
}
/** A category that somehow escaped the vocabulary still gets an archive's hour, never zero. */
const DEFAULT_TTL_MS = 3_600_000
const _ttlFor = (category) => CACHE_TTL_MS[category] ?? DEFAULT_TTL_MS

const FETCH_LIMIT = 20
const LOG = '[news]'

/**
 * The kinds of news read there are — and each one names its SOURCE, which is why the vocabulary is
 * three words and not the four shelves it used to be. `companies` is a ticker, `headlines` is the
 * front page, `topic` is free text. Exported because the agent tool normalizes a model-supplied
 * category against the SAME set rather than keeping a second copy (CLAUDE.md).
 */
export const NEWS_CATEGORIES = new Set(['companies', 'headlines', 'topic'])

/** `headlines` has no subject of its own — one front page, one cache entry. */
export const HEADLINES_SUBJECT = 'top-stories'

/**
 * The three fetches, in one injectable map. Injected rather than imported at the call site so the
 * source split — which question goes to which provider — can be tested without a network, which is
 * the only part of this file a mistake would be invisible in.
 */
const PROVIDERS = {
    companyNews: fetchCompanyNews,
    generalNews: fetchGeneralNews,
    search: fetchGNews,
}

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
 * @param {{ category: string, subject?: string, query?: string, refresh?: boolean }} opts
 * @returns {Promise<{ articles: NewsArticle[], meta: object }>}
 */
async function getOrFetch({ category, subject, query, refresh = false, _providers = PROVIDERS }) {
    const cat = _requireCategory(category)
    // `headlines` is the front page: one feed, one cache entry, no subject to ask for.
    const subj = cat === 'headlines'
        ? HEADLINES_SUBJECT
        : _requireNonEmpty(subject, 'subject')
    // The query defaults to the subject on purpose — a free-form query that differs from the subject
    // would let one phrasing fill a cache entry another phrasing then reads back as its own.
    const searchQuery = cat === 'headlines' ? HEADLINES_SUBJECT : (query?.trim() || subj)

    const store = storePath(cat, subj)
    const cache = await _loadEnvelope(store)
    const ttl = _ttlFor(cat)
    const fresh =
        !refresh && isCacheFresh(cache.lastFetchedAt, ttl)

    if (fresh) {
        return _result(_sortByDatetimeDesc(cache.items), {
            category: cat,
            subject: subj,
            query: cache.query || searchQuery,
            cached: true,
            count: cache.items.length,
            ttlMs: ttl,
        })
    }

    const from =
        cache.lastFetchedAt > 0
            ? new Date(cache.lastFetchedAt).toISOString()
            : _oneMonthAgoISO()
    const to = new Date().toISOString()

    let incoming = []
    let fetchMeta = {}
    try {
        ({ articles: incoming, meta: fetchMeta } = await _fetchArticles({
            category: cat,
            subject: subj,
            query: searchQuery,
            from,
            to,
            limit: FETCH_LIMIT,
        }, _providers))
    } catch (err) {
        // A provider that is down, rate-limited or out of quota must not throw away news we already
        // hold. Serving it stale is the honest answer — every item is dated downstream — and the
        // cache timestamp is NOT bumped, so the next call retries rather than sitting on it for an
        // hour. With nothing cached there is genuinely no answer, so the error still surfaces.
        if (!cache.items.length) throw err
        logger.warn(LOG, `fetch failed for ${cat}/${subj}, serving ${cache.items.length} cached:`, err.message)
        return _result(_sortByDatetimeDesc(cache.items), {
            category: cat,
            subject: subj,
            query: cache.query || searchQuery,
            cached: true,
            stale: true,
            error: err.message,
            count: cache.items.length,
        })
    }

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
        ttlMs: ttl,
        ...fetchMeta,
    })
}

/**
 * The SOURCE decision, made in one place. See the file header for why it splits this way.
 * @returns {Promise<{ articles: NewsArticle[], meta: object }>}
 */
export async function _fetchArticles({ category, subject, query, from, to, limit = FETCH_LIMIT }, providers = PROVIDERS) {
    if (category === 'headlines') return fetchFromFinnhubGeneral({ limit }, providers)

    if (category === 'companies') {
        const result = await fetchFromFinnhubCompany({ symbol: subject, from, to, limit }, providers)
        if (result.articles.length) return result
        // Finnhub covers US listings; a foreign name, an index or a crypto pair comes back empty.
        // Falling through to the text index is what keeps those subjects answerable at all — and it
        // only ever runs when the keyed source had nothing, so the noise it brings is the last resort
        // rather than the default.
        logger.info(LOG, `Finnhub had no news for ${subject} — falling back to the text index`)
        const fallback = await fetchFromGNews({ query, from, to, limit }, providers)
        return _result(fallback.articles, { ...fallback.meta, source: 'gnews', fallback: 'finnhub-empty' })
    }

    return fetchFromGNews({ query, from, to, limit }, providers)
}

/**
 * @param {{ symbol: string, from?: string, to?: string, limit?: number }} opts
 * @returns {Promise<{ articles: NewsArticle[], meta: object }>}
 */
async function fetchFromFinnhubCompany({ symbol, from, to, limit = FETCH_LIMIT }, providers = PROVIDERS) {
    const sym = _requireNonEmpty(symbol, 'symbol').toUpperCase()
    const raw = await providers.companyNews({ symbol: sym, from, to })
    const articles = (Array.isArray(raw) ? raw : []).map(mapFinnhubArticle).filter(isValidArticle)
    // Finnhub returns the window OLDEST-first in places; sort before slicing or a busy name loses
    // exactly the headlines the reader came for.
    const newest = _sortByDatetimeDesc(articles).slice(0, limit)
    return _result(newest, { source: 'finnhub', symbol: sym, from, to, count: newest.length })
}

/** @returns {Promise<{ articles: NewsArticle[], meta: object }>} */
async function fetchFromFinnhubGeneral({ limit = FETCH_LIMIT } = {}, providers = PROVIDERS) {
    const raw = await providers.generalNews()
    const articles = _sortByDatetimeDesc((Array.isArray(raw) ? raw : []).map(mapFinnhubArticle).filter(isValidArticle)).slice(0, limit)
    return _result(articles, { source: 'finnhub', feed: 'general', count: articles.length })
}

/**
 * @param {{ query: string, from?: string, to?: string, limit?: number }} opts
 * @returns {Promise<{ articles: NewsArticle[], meta: object }>}
 */
async function fetchFromGNews({ query, from, to, limit = FETCH_LIMIT }, providers = PROVIDERS) {
    const searchQuery = _requireNonEmpty(query, 'query')
    const raw = await providers.search({
        query: searchQuery,
        from,
        to,
        max: limit,
    })
    const rawArticles = Array.isArray(raw?.articles) ? raw.articles : []
    const articles = rawArticles.map(mapGNewsArticle).filter(isValidArticle)

    return _result(articles, {
        source: 'gnews',
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
    if (!NEWS_CATEGORIES.has(normalized)) {
        throw new Error(`category must be one of: ${[...NEWS_CATEGORIES].join(', ')}`)
    }
    return normalized
}

function _normalizeCategory(category) {
    const c = _requireNonEmpty(category, 'category').toLowerCase()
    if (c === 'company') return 'companies'
    // The shelf names this vocabulary used to carry. They named a cache folder, not a source, and a
    // caller still passing one means a theme search — which is what `topic` is.
    if (c === 'global' || c === 'markets' || c === 'sectors') return 'topic'
    return c
}

function _result(articles, meta = {}) {
    return {
        articles: Array.isArray(articles) ? articles : [],
        meta,
    }
}
