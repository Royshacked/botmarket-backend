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

// symbol → { price, at }. In memory on purpose: it is a cache of the newest observation, not a
// record — the durable copy is the mark stamped on each position row by the mark loop.
const _marks = new Map()

/** Publish an observed price. Called by whatever owns the polling cadence (the paper mark loop). */
export function publish(symbol, price, at = Date.now()) {
    if (!symbol || price == null || !Number.isFinite(price) || price <= 0) return
    _marks.set(String(symbol).toUpperCase(), { price, at })
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
