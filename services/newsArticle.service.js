/**
 * Shared article handling: map raw provider payloads into ONE internal article shape, validate,
 * and dedupe. Used by services/news.service.js — the source behind the news condition evaluator and
 * Axl's `get_news`.
 *
 * TWO providers map in here, and that is the point: Finnhub (symbol-keyed company news and the
 * general top-stories feed) and GNews (free-text themes). Downstream — the cache envelope, the
 * dedupe, the digest the model reads — never learns which one an article came from, so the source
 * split stays a fetching decision instead of leaking into every consumer.
 *
 * Internal article shape:
 *   { datetime: number (unix sec), headline, summary, url, image, source, id }
 *
 * Callers may add their own extra fields by spreading the result of
 * mapGNewsArticle().
 */

/**
 * Map one raw GNews article into the internal shape.
 * `datetime` is NaN when publishedAt is missing/unparseable — use isValidArticle
 * to filter those out.
 * @param {object} item raw GNews article
 */
export function mapGNewsArticle(item) {
    const publishedMs = Date.parse(item?.publishedAt ?? '')
    return {
        datetime: Number.isFinite(publishedMs) ? Math.floor(publishedMs / 1000) : NaN,
        headline: typeof item?.title === 'string' ? item.title.trim() : '',
        summary: typeof item?.description === 'string' ? item.description : '',
        url: item?.url ?? '',
        image: item?.image ?? '',
        source: item?.source?.name ?? '',
        id: item?.id ?? null,
        // Always present, always empty here: a text index tags no tickers. Keeping the field means
        // every consumer reads ONE article shape and no one has to know which provider it came from.
        related: [],
    }
}

/**
 * Map one raw Finnhub article (company-news or the general feed) into the internal shape.
 * Finnhub already dates in unix SECONDS — no division here, unlike the GNews mapper above, and
 * dividing it again is the bug this comment exists to prevent (every article would land in 1970).
 * @param {object} item raw Finnhub article
 */
export function mapFinnhubArticle(item) {
    const dt = Number(item?.datetime)
    return {
        datetime: Number.isFinite(dt) && dt > 0 ? Math.floor(dt) : NaN,
        headline: typeof item?.headline === 'string' ? item.headline.trim() : '',
        summary: typeof item?.summary === 'string' ? item.summary : '',
        url: item?.url ?? '',
        image: item?.image ?? '',
        source: item?.source ?? '',
        id: item?.id ?? null,
        // Every ticker the publisher tagged, e.g. "AMD,NVDA". Carried because a symbol-keyed feed
        // still returns PEER coverage — an AMD piece tagged NVDA — and a reader told only the
        // headline would hear it as Nvidia news. Whether that matters is the model's call; the tags
        // are the data it needs to make it.
        related: _relatedTickers(item?.related),
    }
}

/** "AMD,NVDA" → ['AMD','NVDA']. Absent or unparseable → []. */
function _relatedTickers(raw) {
    if (Array.isArray(raw)) return raw.map(t => String(t).trim().toUpperCase()).filter(Boolean)
    if (typeof raw !== 'string') return []
    return raw.split(/[,;|]/).map(t => t.trim().toUpperCase()).filter(Boolean)
}

/** @param {unknown} item */
export function isValidArticle(item) {
    return (
        item &&
        typeof item === 'object' &&
        Number.isFinite(item.datetime) &&
        typeof item.headline === 'string' &&
        item.headline.length > 0
    )
}

/**
 * Stable dedupe key. Prefers the canonical URL, then a provider id, then a
 * datetime+headline composite. Keys are namespaced so the strategies never
 * collide. Internal to mergeDedupedArticles — export it only if a second
 * caller genuinely needs the same key, rather than growing a parallel one.
 */
function articleKey(item) {
    if (item?.url) return `u:${item.url}`
    if (item?.id != null) return `id:${item.id}`
    return `dt:${item?.datetime}|h:${item?.headline}`
}

/**
 * Merge two article lists: dedupe by key (incoming wins over existing on a key
 * clash), drop invalid articles, and sort newest-first. Also reports which
 * incoming articles were genuinely new.
 * @param {object[]} existing
 * @param {object[]} incoming
 * @returns {{ merged: object[], added: object[] }}
 */
export function mergeDedupedArticles(existing = [], incoming = []) {
    const map = new Map()
    for (const item of [...existing, ...incoming]) {
        if (!isValidArticle(item)) continue
        map.set(articleKey(item), item)
    }
    const merged = [...map.values()].sort((a, b) => b.datetime - a.datetime)

    const existingKeys = new Set(existing.map(articleKey))
    const added = incoming.filter(
        (item) => isValidArticle(item) && !existingKeys.has(articleKey(item))
    )

    return { merged, added }
}
