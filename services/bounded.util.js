// In-memory keys a long-running instance keeps per session (the chain runner's carry counts and handed reads, Mentor's
// experts' lines said) — BOUNDED, oldest out first, so they never grow without end. A forgotten key only allows one more
// carry, hand-off or line. Single instance, like every request-path state (docs/architecture/single-instance.md).

export const KEEP_MAX = 2000

/** Add `key` to a Set, or set `key` → `value` in a Map, as the newest entry; drop the oldest past `max`. */
export function keepBounded(coll, key, value, max = KEEP_MAX) {
    if (coll.has(key)) coll.delete(key)
    if (coll instanceof Map) coll.set(key, value)
    else coll.add(key)
    while (coll.size > max) coll.delete(coll.keys().next().value)
}
