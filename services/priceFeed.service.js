// ── The price feed: one fetcher, two doors ────────────────────────────────────
// Three places used to fetch the same quote for the same symbol on their own timers — the mark
// loop, the equity roll-up, and the chart — and a shared 3-second cache did not dedupe any of them,
// because every caller polled SLOWER than the cache lived. A shared fetcher only helps callers that
// arrive inside the TTL; ours never did. The answer is not a longer cache, it is a publisher:
//
//   ONE loop fetches on ONE cadence and publishes. Everyone else reads what it published.
//
// The two doors, and the judgment that picks between them:
//
//   readMark(symbol)   — free. The last published price. At most one publish interval stale.
//                        For anything DISPLAYING a number: equity, P&L, a position row.
//   fetchFresh(symbol) — costs one request. Live, now.
//                        For anything DECIDING money: pricing an entry or an exit, a touch-fill.
//
// That split is the point. A stale price on a P&L readout is a cosmetic lag; the same stale price
// deciding a fill books a trade at a level the market never printed. So the feed will not guess
// which one a caller wants — the caller says, by choosing a door.
//
// Shares the pipe, not the judgment: the feed owns fetching and publishing, each consumer owns how
// fresh it needs the answer to be.

import { logger } from './logger.service.js'

const LOG = '[priceFeed]'

// symbol → { price, at, recent: [{price, at}, …] }. In memory on purpose: it is a cache of the
// newest observation, not a record — the durable copy is the mark stamped on each position row by
// the mark loop.
const _marks = new Map()

// ── The third door: a short TRAIL of observations, not just the newest ────────
//
// `readMark` answers "where is it now". Talos's guard sweep has to answer a different question —
// "did it CROSS this line since I last looked" — and the newest price cannot answer that. A level
// touched and left between two polls is invisible to a spot read, which is precisely the miss that
// price BANDS existed to paper over (docs/desks/talos-guards.md).
//
// So every publication is kept for a short while and `rangeSince` reads the high/low across them.
// It costs no extra provider call — it reuses prices this app already pays for, from whichever
// consumer happened to fetch them.
//
// BOUNDED TWICE, because this is a process-lifetime map: by COUNT per symbol (a runaway publisher
// cannot grow one entry without limit) and by AGE on read (a trail older than the caller's window
// is not evidence about it). The count is the memory bound; the age is the correctness one.
const TRAIL_MAX = 240

/**
 * Publish an observed price. Called by whatever owns the polling cadence (the paper mark loop) —
 * and, incidentally, by every fetch in the app, which is what makes the trail cheap.
 */
export function publish(symbol, price, at = Date.now()) {
    if (!symbol || price == null || !Number.isFinite(price) || price <= 0) return
    const key  = String(symbol).toUpperCase()
    const prev = _marks.get(key)
    // Out-of-order publications are kept, not sorted: `rangeSince` scans and takes a min/max, so
    // ordering buys nothing, and dropping a late arrival would drop a real observation.
    const recent = prev?.recent ?? []
    recent.push({ price, at })
    if (recent.length > TRAIL_MAX) recent.splice(0, recent.length - TRAIL_MAX)
    // `price`/`at` stay the NEWEST BY TIME rather than the last written, so a late arrival cannot
    // roll the current mark backwards for every readMark caller.
    const newest = !prev || at >= prev.at ? { price, at } : { price: prev.price, at: prev.at }
    _marks.set(key, { ...newest, recent })
}

/**
 * The high and low observed for a symbol since `sinceMs`, or null when nothing was seen in that
 * window. Pure apart from reading the map.
 *
 * THE POINT: a guard asks whether price crossed a line, and a crossing is a fact about an interval,
 * not about an instant. `{high, low}` over the interval answers it; the last price does not.
 *
 * Resolution is bounded by how often anything publishes — a wick between two publications is still
 * invisible. That is a real limit and a far smaller one than a 30-to-240-minute scheduled glance,
 * and the escalation if it ever bites is to confirm a near-firing guard with a real 1-minute candle.
 *
 * @param {string} symbol
 * @param {number} sinceMs  epoch ms; observations at or after this are counted
 * @returns {{high: number, low: number, count: number}|null}
 */
export function rangeSince(symbol, sinceMs) {
    const hit = _marks.get(String(symbol ?? '').toUpperCase())
    if (!hit?.recent?.length) return null

    let high = -Infinity, low = Infinity, count = 0
    for (const o of hit.recent) {
        if (!(o.at >= sinceMs)) continue
        if (o.price > high) high = o.price
        if (o.price < low)  low  = o.price
        count++
    }
    return count ? { high, low, count } : null
}

/**
 * The last published price, or null when there is none — or when it is older than the caller is
 * willing to accept. `maxAgeMs` is the caller's judgment, not the feed's: an equity readout is
 * happy with a minute, a chart tick is not, and neither should be hard-coded here.
 *
 * Null means "I cannot answer that cheaply" — the caller then decides whether to fetch or skip.
 *
 * @param {string} symbol
 * @param {{maxAgeMs?: number}} [opts]
 * @returns {number|null}
 */
export function readMark(symbol, { maxAgeMs = Infinity } = {}) {
    const hit = _marks.get(String(symbol ?? '').toUpperCase())
    if (!hit) return null
    return (Date.now() - hit.at) <= maxAgeMs ? hit.price : null
}

/** Age of the published mark in ms, or null when there is none. For diagnostics and staleness UI. */
export function markAge(symbol, now = Date.now()) {
    const hit = _marks.get(String(symbol ?? '').toUpperCase())
    return hit ? now - hit.at : null
}

/** Everything currently published, newest-first. Diagnostics only. */
export function published() {
    return [..._marks.entries()]
        .map(([symbol, { price, at }]) => ({ symbol, price, at }))
        .sort((a, b) => b.at - a.at)
}

/** Drop a symbol (it stopped being held / watched) so the map tracks what is live. */
export function forget(symbol) {
    _marks.delete(String(symbol ?? '').toUpperCase())
}

/**
 * Split symbols into "already priced recently enough" and "must be fetched". The shape a polling
 * consumer wants: read what someone else already paid for, buy only the rest.
 *
 * `maxAgeMs` MUST be shorter than the caller's own polling interval — otherwise its own publication
 * from the previous tick satisfies the next one and it stops refreshing forever, quietly serving a
 * price frozen at whenever it last actually looked. Half the interval is the safe default.
 *
 * @param {Iterable<string>} symbols
 * @param {number} maxAgeMs
 * @returns {{fresh: Map<string, number>, stale: string[]}}
 */
export function partitionByFreshness(symbols, maxAgeMs) {
    const fresh = new Map()
    const stale = []
    for (const symbol of new Set(symbols)) {
        const px = readMark(symbol, { maxAgeMs })
        if (px != null) fresh.set(symbol, px)
        else stale.push(symbol)
    }
    return { fresh, stale }
}

/** Testing seam. */
export function _reset() {
    _marks.clear()
}

/**
 * Retire published marks for symbols nobody is following any more, so the map stays the size of
 * what is live rather than of everything ever seen. Returns how many were dropped.
 */
export function retainOnly(symbols) {
    const keep = new Set([...symbols].map(s => String(s).toUpperCase()))
    let dropped = 0
    for (const symbol of [..._marks.keys()]) {
        if (!keep.has(symbol)) { _marks.delete(symbol); dropped++ }
    }
    if (dropped) logger.info(LOG, `retired ${dropped} unfollowed symbol(s)`)
    return dropped
}
