// THE HOUSE'S RATING BANDS — a rating is a band of the return the price target implies, AGAINST THE MARKET over the
// target's horizon (Roy, 2026-10-28: "relative to SPY, build it"). The way the big desks rate (overweight / underweight
// against a benchmark), and the way Prometheus is graded: his scorecard measures every call against SPY.
//
// Before it a rating was a DIRECTION only — a target above the price "could only carry" a buy-side rating — and nothing
// said how much: at the call, his holds ran from −30% to +37% and his buys from +3% (230 calls on axl_dev, 2026-10-28).
//
//   market   what SPY is expected to return over the horizon — MARKET_PA a year, pro rata
//   excess   the target's implied return less the market's
//   bands    strong_buy ≥ 2×margin · buy ≥ margin · hold between · sell ≤ −margin · strong_sell ≤ −2×margin,
//            the margin MARGIN_PA a year, pro rata (12m: buy from about +16%, sell at about 0% or under)
//
// The numbers are a starting point, not tested: the scorecard shows whether the bands separate anything.

import { normalizeHorizon } from './forecastClock.js'

/**
 * The revision kind of a RELABEL — live coverage re-rated by the bands from its own target (coverage.service
 * rerateCoverage, 2026-10-28). Not a call of Prometheus's: the scorecard neither logs it nor rebuilds one from it.
 */
export const RERATE_KIND = 'house_rerate'

/** SPY's expected return a year, %. */
export const MARKET_PA = 8
/** The excess over the market a buy needs (and a sell under it), a year, %. */
export const MARGIN_PA = 8

const MONTHS = { '3m': 3, '6m': 6, '12m': 12, '18m': 18, '24m': 24 }
const _r1 = (v) => Math.round(v * 10) / 10

/**
 * The band a price target falls in → `{ rating, implied_pct, market_pct, excess_pct, margin_pct, horizon }`, or null
 * (no target, no price). Pure.
 */
export function ratingBand({ target, price, horizon } = {}) {
    const pt = Number(target), px = Number(price)
    if (!(pt > 0) || !(px > 0)) return null
    const h = normalizeHorizon(horizon)
    const years = (MONTHS[h] ?? 12) / 12
    // Compared as SHOWN — to a tenth: 100 → 116 is +16.0%, not 15.9999… a hair under the buy line.
    const implied = _r1((pt / px - 1) * 100)
    const market = _r1(MARKET_PA * years)
    const margin = _r1(MARGIN_PA * years)
    const excess = _r1(implied - market)
    const rating = excess >= 2 * margin ? 'strong_buy' : excess >= margin ? 'buy'
        : excess <= -2 * margin ? 'strong_sell' : excess <= -margin ? 'sell' : 'hold'
    return { rating, implied_pct: implied, market_pct: market, excess_pct: excess, margin_pct: margin, horizon: h }
}

/** The bands in words for one horizon — what the prompt and a note say. Pure. */
export function bandsText(horizon = '12m') {
    const h = normalizeHorizon(horizon)
    const years = (MONTHS[h] ?? 12) / 12
    const m = _r1(MARKET_PA * years), g = _r1(MARGIN_PA * years)
    const at = (x) => { const v = _r1(m + x); return `${v >= 0 ? '+' : ''}${v}%` }
    return `${h}: SPY ~${at(0)} — strong buy from ${at(2 * g)}, buy from ${at(g)}, sell at ${at(-g)} or under, strong sell at ${at(-2 * g)} or under, hold between`
}
