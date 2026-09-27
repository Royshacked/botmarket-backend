// Bounded-concurrency map — run an async function over a list, N at a time.
//
// THE ONE WORKER POOL. Two callers had grown their own copy of the same eight lines: the company
// profile enrichment (which caps Finnhub fan-out) and, before this, nothing else — the batch read ran
// strictly one name at a time. Adding a second copy for the batch read is what this exists to avoid.
//
// NOT THE RENDER POOL, which stays where it is (klineRender's counting semaphore). That one guards a
// process-wide RESOURCE across unrelated callers — one headless browser, however many monitors are
// firing — and its cap has to hold across calls it never sees. This bounds ONE batch, and the cap is
// a property of the batch. They look alike and are not the same mechanism.
//
// UNBOUNDED IS THE BUG THIS PREVENTS. `Promise.all(items.map(fn))` on a hundred-item list opens a
// hundred sockets at once, which is how the scanner's quote fan-out starved its own calendar call of
// the request budget and came back with "quote unavailable" for half a board.

/**
 * Run `fn` over `items`, at most `concurrency` at a time.
 *
 * RESULTS COME BACK IN INPUT ORDER, not completion order — a caller that pairs a result with the
 * item it came from (or logs a batch, or diffs two runs) needs that, and "whichever finished first"
 * is not a property anyone wants to depend on.
 *
 * ERRORS ARE THE CALLER'S. A rejection from `fn` rejects this, which is the right default for a
 * batch that is meaningless half-done; a batch where one item failing must not cost the rest catches
 * inside `fn` and returns its own row (see aetherBatchRead). This deliberately has no swallow mode:
 * the choice is a judgment about the work, and a flag here would hide it from the caller that owns it.
 *
 * @param {Array}    items
 * @param {Function} fn           (item, index) => Promise<result>
 * @param {number}   concurrency  how many run at once; clamped to at least 1
 * @returns {Promise<Array>}      results, one per item, in the order the items came in
 */
export async function mapLimit(items, fn, { concurrency = 5 } = {}) {
    const list = Array.isArray(items) ? items : []
    if (!list.length) return []

    const out   = new Array(list.length)
    const width = Math.max(1, Math.min(Math.floor(concurrency) || 1, list.length))
    // A SHARED CURSOR, not a pre-sliced list per worker: the items cost different amounts (a cached
    // read returns at once, a fresh one spends a model call), so fixed slices leave one worker
    // grinding while the others have finished. Every worker takes the next index there is.
    let next = 0

    async function worker() {
        while (next < list.length) {
            const i = next++
            out[i] = await fn(list[i], i)
        }
    }
    await Promise.all(Array.from({ length: width }, worker))
    return out
}
