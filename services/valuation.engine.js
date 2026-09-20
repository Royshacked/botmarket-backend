// Deterministic relative valuation (T1) — the Analyst's on-brand computed price target (P2 of the
// Analyst build; see project_analyst_agent). PURE: given a forward metric + a justified multiple
// (+ the stock's historical multiples for a sensitivity range), produce OUR price target, a
// bear/base/bull band, and the GAP vs the Street. Never LLM-vibes — the JUDGMENT (which multiple to
// justify, whose estimate to trust) is the agent's; the arithmetic + transparent breakdown are here.
// Mirrors smc.engine.js (deterministic primitives, the agent decides). Shared by the agent (P3) and
// the coverage monitor (P5) so "our number" has one source of truth.

import { toNum }       from './format.util.js'
import { roundOrNull } from './number.util.js'

// Supported per-sector methods. pe → price = multiple × forward EPS. ev_* → EV = multiple × forward
// metric, then EV→equity→per-share. (DCF/SOTP = T2, deferred.)
export const VALUATION_METHODS = ['pe', 'ev_sales', 'ev_ebitda']

const _num = toNum   // the one safe coercion — see format.util.toNum

// Percentile over a numeric array (linear interpolation between ranks). Pure.
export function percentile(xs, p) {
    const a = (Array.isArray(xs) ? xs : []).filter(x => Number.isFinite(x)).sort((x, y) => x - y)
    if (!a.length) return null
    if (a.length === 1) return a[0]
    const idx = (p / 100) * (a.length - 1)
    const lo = Math.floor(idx), hi = Math.ceil(idx)
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo)
}
export const median = xs => percentile(xs, 50)

/**
 * A scenario leg: its OWN multiple AND its OWN forward metric. Pure. Returns null when the leg is
 * absent or unusable, which drops the band back to sensitivity for that side.
 *
 * This is the whole point of the scenario band. A real bear case moves BOTH inputs — in a downturn
 * the multiple compresses and earnings fall together — which a shared-`fwd` sensitivity cannot
 * express at any multiple. Defaults let a leg vary just one: give a multiple only, and it is a
 * re-rating scenario on unchanged earnings; give a forward metric only, and it is an earnings
 * scenario at the base multiple.
 */
function _leg(raw, { baseMultiple, baseFwd }) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    // ABSENT inherits the base; PRESENT-but-unusable rejects the whole leg. The distinction matters:
    // a typo'd multiple that quietly inherited the base would price the "bear case" AT the base case
    // — a band that looks legitimate while carrying no downside at all, which is precisely the class
    // of silent-nonsense this field already produced once.
    const read = (key, fallback) => {
        if (raw[key] === null || raw[key] === undefined) return fallback
        const n = _num(raw[key])
        return (n !== null && n > 0) ? n : null
    }
    const mult = read('multiple', baseMultiple)
    const fwd  = read('forward_metric', baseFwd)
    if (mult === null || fwd === null) return null

    // An empty leg is not a scenario — nothing was modelled, so leave that side as sensitivity.
    const supplied = ['multiple', 'forward_metric'].some(k => raw[k] !== null && raw[k] !== undefined)
    if (!supplied) return null

    return { multiple: mult, forward_metric: fwd }
}

/**
 * Compute our relative-valuation price target. Returns { ok:false, reason } on unusable input, else
 * a transparent breakdown. The base multiple is the agent's `multiple` if given (the edge), else
 * derived from the stock's own history.
 *
 * The bear/bull band comes from ONE of two bases, and the result says which in `band_basis`:
 *
 *   'scenario'              — the caller supplied `scenarios.bear` / `scenarios.bull`, each with its
 *                             own multiple and/or forward metric. A real downside case.
 *   'multiple_sensitivity'  — no scenarios: ±15% around the provided multiple (or the historical
 *                             quartiles when we derive it), with the forward metric HELD CONSTANT.
 *
 * Reading the second as if it were the first is what put a "bear case" $193 ABOVE spot on a bullish
 * name and had it treated as an invalidation level. A sensitivity band says how much the PT moves if
 * the market pays a different multiple for the SAME earnings — it is not a claim about downside, and
 * `band_basis` exists so no consumer can assume otherwise.
 */
export function computeValuation(input = {}) {
    const method = VALUATION_METHODS.includes(input.method) ? input.method : 'pe'
    const fwd = _num(input.forward_metric)
    // pe needs positive EPS (can't multiple a loss); ev_ebitda needs positive EBITDA; ev_sales revenue.
    if (fwd === null || fwd <= 0) return { ok: false, reason: 'forward_metric_required' }

    const hist  = (Array.isArray(input.historical_multiples) ? input.historical_multiples : []).map(_num).filter(x => x !== null && x > 0)
    const peers = (Array.isArray(input.peer_multiples) ? input.peer_multiples : []).map(_num).filter(x => x !== null && x > 0)
    const provided = _num(input.multiple)

    let base, low, high, basis
    if (provided !== null && provided > 0) {
        base = provided; basis = 'provided'
        low = base * 0.85; high = base * 1.15   // ±15% sensitivity around our justified multiple
    } else if (hist.length >= 4) {
        low = percentile(hist, 25); base = percentile(hist, 50); high = percentile(hist, 75); basis = 'historical_quartiles'
    } else if (hist.length) {
        base = median(hist); basis = 'historical_median'; low = base * 0.85; high = base * 1.15
    } else {
        return { ok: false, reason: 'no_multiple' }   // need a provided multiple OR history to anchor
    }

    const shares  = _num(input.shares_out)
    const netDebt = _num(input.net_debt) ?? 0
    // Price one leg from ITS OWN multiple and ITS OWN forward metric.
    const toPrice = (mult, metric = fwd) => {
        if (method === 'pe') return mult * metric            // multiple × EPS = price per share
        if (shares === null || shares <= 0) return null      // ev_* needs a share count for the equity bridge
        return ((mult * metric) - netDebt) / shares          // EV = mult×metric → equity → per share
    }

    // Scenario legs win over the sensitivity band when supplied. Each side is independent: a caller
    // may model a real bear and leave the bull as sensitivity.
    const sc       = (input.scenarios && typeof input.scenarios === 'object') ? input.scenarios : {}
    const bearLeg  = _leg(sc.bear, { baseMultiple: base, baseFwd: fwd })
    const bullLeg  = _leg(sc.bull, { baseMultiple: base, baseFwd: fwd })
    const bandBasis = (bearLeg || bullLeg) ? 'scenario' : 'multiple_sensitivity'

    const lowLeg  = bearLeg ?? { multiple: low,  forward_metric: fwd }
    const highLeg = bullLeg ?? { multiple: high, forward_metric: fwd }

    const ptBase = toPrice(base, fwd)
    const ptLow  = toPrice(lowLeg.multiple,  lowLeg.forward_metric)
    const ptHigh = toPrice(highLeg.multiple, highLeg.forward_metric)
    if (ptBase === null) return { ok: false, reason: 'ev_needs_shares' }

    const consensusPt = _num(input.consensus_pt)
    const price       = _num(input.current_price)

    return {
        ok: true,
        method,
        multiple: { used: roundOrNull(base), low: roundOrNull(low), high: roundOrNull(high), basis },
        forward_metric: fwd,
        // What the band MEANS — 'scenario' (own multiple + own earnings per leg) or
        // 'multiple_sensitivity' (±15% re-rate on unchanged earnings). Never assume; read this.
        band_basis: bandBasis,
        pt: { bear: roundOrNull(ptLow), base: roundOrNull(ptBase), bull: roundOrNull(ptHigh) },
        // Each leg carries the inputs that produced it, so a stored band documents itself: a bear of
        // 700 reads as "3.2x on trough EPS 220", not as a bare number indistinguishable from a typo.
        legs: {
            bear: { value: roundOrNull(ptLow),  multiple: roundOrNull(lowLeg.multiple),  forward_metric: lowLeg.forward_metric,  basis: bearLeg ? 'scenario' : 'multiple_sensitivity' },
            base: { value: roundOrNull(ptBase), multiple: roundOrNull(base),             forward_metric: fwd,                    basis: 'base' },
            bull: { value: roundOrNull(ptHigh), multiple: roundOrNull(highLeg.multiple), forward_metric: highLeg.forward_metric, basis: bullLeg ? 'scenario' : 'multiple_sensitivity' },
        },
        our_pt: roundOrNull(ptBase),
        consensus_pt: consensusPt,
        // THE EDGE — our PT vs the Street's (absolute + %). null when no consensus PT to compare.
        gap: consensusPt !== null && consensusPt !== 0
            ? { value: roundOrNull(ptBase - consensusPt), pct: roundOrNull((ptBase - consensusPt) / consensusPt * 100) }
            : null,
        // The MARKET leg. Echoed back (not just the derived %) because the reader has to be able to
        // see which side of spot the target landed on: a rating is a claim about the price, and a
        // target the market has already passed cannot support one in that direction.
        current_price: (price !== null && price > 0) ? price : null,
        upside_pct: (price !== null && price > 0) ? roundOrNull((ptBase - price) / price * 100) : null,
        // Context for the reader: where our multiple sits vs the stock's own history + its peers.
        historical_median_multiple: hist.length ? roundOrNull(median(hist)) : null,
        peer_median_multiple: peers.length ? roundOrNull(median(peers)) : null,
    }
}

// ─── One event, priced alone ─────────────────────────────────────────────────
//
// WHAT ONE EVENT IS WORTH TO THE PRICE, holding everything else still. Aether names a company as
// exposed to an event and Prometheus's quick read says whether the exposure is credible; this
// puts a number on it, so "priced in" has a yardstick — a name that moved 13% on an event worth
// 3% has overshot, one that moved 1% on an event worth 8% is still open — instead of resting on
// the estimate trend alone. It is FIRST-ORDER BY CONSTRUCTION: the multiple is held constant
// (no re-rating, no sentiment), and the rest of the estimate is untouched. That is the point of
// asking about the event only.
//
// The chain, per share of forward earnings:
//
//   Δ net income   = revenue × exposed_revenue_pct × shock_pct × incremental_margin × (quarters / 4)
//   Δ EPS %        = Δ net income / net income
//   Δ price %      = Δ EPS %                       (constant multiple)
//   remaining      = Δ price % − what the name has already moved since the event
//
// The agent supplies the FOUR JUDGEMENT INPUTS — how much of revenue the event reaches, how hard
// it hits that line, how much of a dollar there reaches the bottom line, and for how long — and
// this does the arithmetic on the Street's forward revenue and net income, so the answer's
// assumptions are on its face and nothing is vibed. Two of the four (shock, persistence) dominate
// the answer, which is why the shock takes a low and a high and the result is a band, never a
// point. Persistence is capped at a year: forward EPS is annual, and an effect that outlives it
// is a re-rating question, not this tool's.
//
// A LOSS-MAKER HAS NO EPS BASE. Δ net income is still computable and is reported in dollars; the
// percentage of price is not, and the result says so rather than dividing by a negative.

export const EVENT_DELTA_MAX_QUARTERS = 4

function _in(v, lo, hi) { const n = _num(v); return n === null ? null : Math.min(Math.max(n, lo), hi) }

export function computeEventDelta(input = {}) {
    const exposed  = _in(input.exposed_revenue_pct, 0, 1)
    const shock    = _in(input.shock_pct, -1, 3)
    const margin   = _in(input.incremental_margin, 0, 1)
    const quarters = _in(input.persistence_quarters, 0.25, 8)
    if (exposed === null || shock === null || margin === null || quarters === null) {
        return { ok: false, reason: 'inputs_required' }
    }
    const revenue = _num(input.revenue), netIncome = _num(input.net_income), spot = _num(input.spot)
    if (revenue === null || revenue <= 0) return { ok: false, reason: 'no_revenue' }

    const persistence = Math.min(quarters, EVENT_DELTA_MAX_QUARTERS) / 4
    const leg = s => revenue * exposed * s * margin * persistence
    const shockLow  = _in(input.shock_low,  -1, 3)
    const shockHigh = _in(input.shock_high, -1, 3)
    // The band is ordered by VALUE, not by which leg was called low: a negative shock's "low" leg
    // is the larger loss, and a reader wants the worse number on the left every time.
    const legs = [leg(shock), shockLow !== null ? leg(shockLow) : null, shockHigh !== null ? leg(shockHigh) : null].filter(x => x !== null)
    const dNI = leg(shock), dNILow = Math.min(...legs), dNIHigh = Math.max(...legs)

    const out = {
        ok: true,
        inputs: { exposed_revenue_pct: exposed, shock_pct: shock, shock_low: shockLow, shock_high: shockHigh,
                  incremental_margin: margin, persistence_quarters: quarters, persistence_capped: quarters > EVENT_DELTA_MAX_QUARTERS },
        revenue, net_income: netIncome, spot: spot !== null && spot > 0 ? spot : null,
        delta_net_income: roundOrNull(dNI),
        delta_net_income_low: roundOrNull(dNILow),
        delta_net_income_high: roundOrNull(dNIHigh),
        delta_price_pct: null, delta_price_low: null, delta_price_high: null, implied_price: null,
        moved_pct: _num(input.moved_pct), remaining_pct: null,
    }
    if (netIncome === null || netIncome <= 0) return { ...out, reason: 'no_earnings_base' }

    const pct = d => d / netIncome * 100
    out.delta_price_pct  = roundOrNull(pct(dNI))
    out.delta_price_low  = roundOrNull(pct(dNILow))
    out.delta_price_high = roundOrNull(pct(dNIHigh))
    if (out.spot) out.implied_price = roundOrNull(out.spot * (1 + pct(dNI) / 100))
    // What is still open, on the base leg. moved_pct is the excess move since the event, in %,
    // the way Aether measures it (vs SPY): the part of the answer the market has already given.
    if (out.moved_pct !== null) out.remaining_pct = roundOrNull(pct(dNI) - out.moved_pct)
    return out
}
