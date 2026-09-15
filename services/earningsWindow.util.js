// The earnings-calendar join, in the two pieces that are genuinely shared.
//
// upcomingEvents.service left a note asking for an `earningsBySymbol(symbols, {from,to})` once a
// second caller appeared (portfolioState is it). Read together, the two callers share LESS than that
// signature implies, and the difference is the interesting part:
//
//   - The WINDOW is identical: today, plus thirty days, as YYYY-MM-DD. Written twice, two ways
//     (`new Date().toISOString().slice(0,10)` vs an `_iso` helper over `864e5`). That is real
//     duplication of a real decision — how far ahead "upcoming" reaches — and it lives here now.
//
//   - The FETCH is not shared, deliberately. computePortfolioState swallows a failure into "no
//     earnings shown", because a holding's row is still worth rendering without its earnings date.
//     upcomingEvents must REPORT the failure — it answers "anything coming up?" and names what it
//     could not read in `unavailable`, so a wrapper that never throws would delete the only signal
//     it has. Wrapping both in one "safe" fetch would make the honest caller lie.
//
//   - The INDEXING is portfolio-only: one date per name, to hang off a holding. The events feed
//     wants every row it got, because several names can report in the same window.
//
// So: the window and the indexing are here, and each caller keeps the fetch it needs.

/** How far ahead "upcoming" reaches. One number, previously written into both callers. */
export const EARNINGS_WINDOW_DAYS = 30

/**
 * The calendar window as the provider wants it — YYYY-MM-DD, today through +days.
 *
 * @param {number} [now]   epoch ms, injectable so a test is not dated
 * @param {number} [days]
 * @returns {{ from: string, to: string }}
 */
export function earningsWindow(now = Date.now(), days = EARNINGS_WINDOW_DAYS) {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
    return { from: iso(now), to: iso(now + days * 86400000) }
}

/**
 * Calendar rows → one entry per symbol, FIRST row winning.
 *
 * First and not nearest: the provider returns the window in date order, so the first row for a name
 * is its next report, which is the one a holding's "⚠ earnings" flag is about. Pure.
 *
 * @param {Array<{symbol?: string, date?: string, epsEstimated?: number}>} rows
 * @returns {Map<string, { date: string, epsEstimate: number|null }>}  keyed by UPPERCASE symbol
 */
export function earningsBySymbol(rows) {
    const out = new Map()
    for (const r of (Array.isArray(rows) ? rows : [])) {
        const sym = String(r?.symbol ?? '').toUpperCase()
        if (!sym || out.has(sym)) continue
        out.set(sym, { date: r.date, epsEstimate: r.epsEstimated ?? null })
    }
    return out
}
