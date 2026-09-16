// Tiny TTL cache with a bounded size. Backed by a Map so insertion order gives
// us cheap LRU-ish eviction: when we exceed `max`, drop the oldest entry rather
// than clearing the whole cache (which would thrash a busy key).
//
// get() returns the stored value when fresh (Date.now() - storedAt < ttlMs),
// otherwise deletes the stale entry and returns undefined.

/**
 * Is a timestamp still inside its window? The freshness test for the two envelope caches (candles,
 * news) that KEEP a stale value — for them staleness decides whether to REFRESH, never whether the
 * data is usable, which is why they are not createTtlCache (it deletes on expiry). A missing
 * timestamp is never fresh.
 */
export function isCacheFresh(lastFetchedAt, cacheTimeMs = 5 * 60 * 1000) {
    if (!lastFetchedAt) return false
    return Date.now() - lastFetchedAt < cacheTimeMs
}

export function createTtlCache({ ttlMs, max = 500 } = {}) {
    const store = new Map() // key -> { value, at: epochMs }

    return {
        get(key) {
            const hit = store.get(key)
            if (!hit) return undefined
            if (Date.now() - hit.at < ttlMs) return hit.value
            store.delete(key)
            return undefined
        },
        set(key, value) {
            store.set(key, { value, at: Date.now() })
            while (store.size > max) {
                const oldest = store.keys().next().value
                store.delete(oldest)
            }
            return value
        },
        delete(key) {
            return store.delete(key)
        },
        clear() {
            store.clear()
        },
    }
}
