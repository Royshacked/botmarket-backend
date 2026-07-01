// Tiny TTL cache with a bounded size. Backed by a Map so insertion order gives
// us cheap LRU-ish eviction: when we exceed `max`, drop the oldest entry rather
// than clearing the whole cache (which would thrash a busy key).
//
// get() returns the stored value when fresh (Date.now() - storedAt < ttlMs),
// otherwise deletes the stale entry and returns undefined.

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
