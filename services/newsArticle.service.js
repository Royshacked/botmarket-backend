/**
 * Shared GNews article handling: map raw GNews payloads into the internal
 * article shape, validate, and dedupe. Used by services/news.service.js (the
 * Hermes news evaluator's source).
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
    }
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
