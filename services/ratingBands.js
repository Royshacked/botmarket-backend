// THE HOUSE'S RATING BANDS — a rating is a band of the return the price target implies, AGAINST THE MARKET over the
// target's horizon (Roy, 2026-10-28: "relative to SPY, build it"). The way the big desks rate (overweight / underweight
// against a benchmark), and the way Prometheus is graded: his scorecard measures every call against SPY.
//
// Before it a rating was a DIRECTION only — a target above the price "could only carry" a buy-side rating — and nothing
// said how much: at the call, his holds ran from −30% to +37% and his buys from +3% (230 calls on axl_dev, 2026-10-28).
//
//   market   what SPY is expected to return over the horizon — MARKET_PA a year, pro rata
//   excess   the target's implied return less the market's
//   margin   IN THE STOCK'S OWN σ over the horizon since 2026-11-21 — SIGMA_MARGIN × σ (Proteus's: 60 daily returns,
//            × √ the horizon's trading days). Without a σ, the flat MARGIN_PA a year, pro rata (the 2026-10-28 rule).
//   bands    strong_buy ≥ 2×margin · buy ≥ margin · hold between · sell ≤ −margin · strong_sell ≤ −2×margin
//   cap      a LOW-conviction call is never "strong": strong_buy → buy, strong_sell → sell
//
// WHY σ (Roy, 2026-11-21, on the review of 263 open calls on prod). The flat margin pro-rated to almost nothing on short
// horizons — a 3m target 2% under the price was a strong SELL, 6% over it a strong BUY — while a stock's 3-month σ is
// ~18% (the median there). 22 of the open 3m "strong" calls implied moves under 10%. A target's distance only says
// something against how far the stock wanders anyway. 0.25σ / 0.5σ was picked over 0.5σ / 1σ (81% holds — the label
// stops saying anything) on that same set: ~13% strong buy, ~22% buy, ~52% hold, ~7% sell, ~6% strong sell.
// And the cap: 76 of the 111 strong calls were low conviction — a desk does not put its strongest word on its weakest view.
//
// The numbers are still a starting point: the scorecard shows whether the bands separate anything.

import { normalizeHorizon } from './forecastClock.js'

/**
 * The revision kind of a RELABEL — live coverage re-rated by the bands from its own target (coverage.service
 * rerateCoverage, 2026-10-28; daily from the coverage monitor since 2026-11-21). Not a call of Prometheus's: the
 * scorecard neither logs it nor rebuilds one from it.
 */
export const RERATE_KIND = 'house_rerate'

/** SPY's expected return a year, %. */
export const MARKET_PA = 8
/** The flat margin — the excess over the market a buy needs (and a sell under it), a year, % — used without a σ. */
export const MARGIN_PA = 8
/** The margin in σ over the horizon: buy from 1×, strong from 2× (0.25σ / 0.5σ). */
export const SIGMA_MARGIN = 0.25

const MONTHS = { '3m': 3, '6m': 6, '12m': 12, '18m': 18, '24m': 24 }
/** Trading days a month — the horizon's σ is the daily σ × √(21 × months). */
const DAYS_PER_MONTH = 21
const _r1 = (v) => Math.round(v * 10) / 10
const STRONG_CAP = { strong_buy: 'buy', strong_sell: 'sell' }

/** A horizon in months ('6m' → 6; none → the house's 12). Pure. */
export const horizonMonths = (horizon) => MONTHS[normalizeHorizon(horizon)] ?? 12

/**
 * σ over a horizon, in % — from a per-month σ as a FRACTION (Proteus's swing scale: 60 daily returns × √21) → × √months.
 * Null when there is none. Pure.
 */
export function horizonSigmaPct(monthlySigma, horizon) {
    const s = Number(monthlySigma)
    if (!(s > 0) || !Number.isFinite(s)) return null
    return _r1(s * Math.sqrt(horizonMonths(horizon)) * 100)
}

/** The same from a per-DAY σ as a fraction (a call's own bars). Pure. */
export const horizonSigmaPctFromDaily = (dailySigma, horizon) =>
    horizonSigmaPct(Number(dailySigma) * Math.sqrt(DAYS_PER_MONTH), horizon)

/**
 * The band a price target falls in → `{ rating, implied_pct, market_pct, excess_pct, margin_pct, basis, sigma_pct,
 * capped, horizon }`, or null (no target, no price). `sigma_pct` — the stock's σ over the target's horizon, % (null →
 * the flat margin, `basis: 'flat'`); `conviction` — the call's level ('low' caps a strong rating, `capped: true`). Pure.
 */
export function ratingBand({ target, price, horizon, sigma_pct = null, conviction = null } = {}) {
    const pt = Number(target), px = Number(price)
    if (!(pt > 0) || !(px > 0)) return null
    const h = normalizeHorizon(horizon)
    const years = horizonMonths(h) / 12
    const sig = Number(sigma_pct)
    const bySigma = sig > 0 && Number.isFinite(sig)
    // Compared as SHOWN — to a tenth: 100 → 116 is +16.0%, not 15.9999… a hair under the buy line.
    const implied = _r1((pt / px - 1) * 100)
    const market = _r1(MARKET_PA * years)
    const margin = _r1(bySigma ? SIGMA_MARGIN * sig : MARGIN_PA * years)
    const excess = _r1(implied - market)
    const band = excess >= 2 * margin ? 'strong_buy' : excess >= margin ? 'buy'
        : excess <= -2 * margin ? 'strong_sell' : excess <= -margin ? 'sell' : 'hold'
    const capped = conviction === 'low' && band in STRONG_CAP
    return {
        rating: capped ? STRONG_CAP[band] : band, implied_pct: implied, market_pct: market, excess_pct: excess,
        margin_pct: margin, basis: bySigma ? 'sigma' : 'flat', sigma_pct: bySigma ? _r1(sig) : null, capped, horizon: h,
    }
}

/**
 * THE GUARD ON A DAILY RE-RATE (2026-11-22): the label leaves its band only once the excess is clearly past the edge —
 * HYSTERESIS × the margin beyond it (0.05σ at a 0.25σ margin). σ and the price move every day; without it a name sitting
 * on an edge flips buy ↔ hold day after day, a revision each time (the 512 MB quota). A save — a new call — is never
 * held: the guard is for a label following the price, not for Prometheus setting it.
 */
export const HYSTERESIS = 0.2

/**
 * `band` (ratingBand's) held at `prevRating` while the excess is still inside that rating's band widened by the guard →
 * the band with `rating: prevRating, held: true`; else `band` as it is. A LOW conviction widens buy upward and sell
 * downward (its strong side is capped onto them) and never holds a strong rating it may not carry. Pure.
 */
export function stickyBand(band, prevRating, { conviction = null } = {}) {
    if (!band || !prevRating || band.rating === prevRating) return band
    const m = Number(band.margin_pct)
    if (!(m > 0)) return band
    const edges = { strong_buy: [2 * m, Infinity], buy: [m, 2 * m], hold: [-m, m], sell: [-2 * m, -m], strong_sell: [-Infinity, -2 * m] }
    if (!edges[prevRating]) return band
    let [lo, hi] = edges[prevRating]
    if (conviction === 'low') {
        if (prevRating in STRONG_CAP) return band
        if (prevRating === 'buy') hi = Infinity
        if (prevRating === 'sell') lo = -Infinity
    }
    const buf = HYSTERESIS * m
    const x = Number(band.excess_pct)
    return x > lo - buf && x < hi + buf ? { ...band, rating: prevRating, held: true } : band
}

/** The bands in words for one horizon — what a note says. With `sigma_pct` the σ bands, else the flat ones. Pure. */
export function bandsText(horizon = '12m', { sigma_pct = null } = {}) {
    const h = normalizeHorizon(horizon)
    const years = horizonMonths(h) / 12
    const sig = Number(sigma_pct)
    const m = _r1(MARKET_PA * years), g = _r1(sig > 0 ? SIGMA_MARGIN * sig : MARGIN_PA * years)
    const at = (x) => { const v = _r1(m + x); return `${v >= 0 ? '+' : ''}${v}%` }
    return `${h}: SPY ~${at(0)}${sig > 0 ? `, σ ${_r1(sig)}%` : ''} — strong buy from ${at(2 * g)}, buy from ${at(g)}, sell at ${at(-g)} or under, strong sell at ${at(-2 * g)} or under, hold between`
}
