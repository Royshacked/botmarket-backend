// Deterministic relative valuation (T1) — the Analyst's on-brand computed price target (P2 of the
// Analyst build; see project_analyst_agent). PURE: given a forward metric + a justified multiple
// (+ the stock's historical multiples for a sensitivity range), produce OUR price target, a
// bear/base/bull band, and the GAP vs the Street. Never LLM-vibes — the JUDGMENT (which multiple to
// justify, whose estimate to trust) is the agent's; the arithmetic + transparent breakdown are here.
// Mirrors smc.engine.js (deterministic primitives, the agent decides). Shared by the agent (P3) and
// the coverage monitor (P5) so "our number" has one source of truth.

// Supported per-sector methods. pe → price = multiple × forward EPS. ev_* → EV = multiple × forward
// metric, then EV→equity→per-share. (DCF/SOTP = T2, deferred.)
export const VALUATION_METHODS = ['pe', 'ev_sales', 'ev_ebitda']

const _num = v => { const n = Number(v); return Number.isFinite(n) ? n : null }
const _round2 = x => (x === null ? null : Math.round(x * 100) / 100)

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
        multiple: { used: _round2(base), low: _round2(low), high: _round2(high), basis },
        forward_metric: fwd,
        // What the band MEANS — 'scenario' (own multiple + own earnings per leg) or
        // 'multiple_sensitivity' (±15% re-rate on unchanged earnings). Never assume; read this.
        band_basis: bandBasis,
        pt: { bear: _round2(ptLow), base: _round2(ptBase), bull: _round2(ptHigh) },
        // Each leg carries the inputs that produced it, so a stored band documents itself: a bear of
        // 700 reads as "3.2x on trough EPS 220", not as a bare number indistinguishable from a typo.
        legs: {
            bear: { value: _round2(ptLow),  multiple: _round2(lowLeg.multiple),  forward_metric: lowLeg.forward_metric,  basis: bearLeg ? 'scenario' : 'multiple_sensitivity' },
            base: { value: _round2(ptBase), multiple: _round2(base),             forward_metric: fwd,                    basis: 'base' },
            bull: { value: _round2(ptHigh), multiple: _round2(highLeg.multiple), forward_metric: highLeg.forward_metric, basis: bullLeg ? 'scenario' : 'multiple_sensitivity' },
        },
        our_pt: _round2(ptBase),
        consensus_pt: consensusPt,
        // THE EDGE — our PT vs the Street's (absolute + %). null when no consensus PT to compare.
        gap: consensusPt !== null && consensusPt !== 0
            ? { value: _round2(ptBase - consensusPt), pct: _round2((ptBase - consensusPt) / consensusPt * 100) }
            : null,
        upside_pct: (price !== null && price > 0) ? _round2((ptBase - price) / price * 100) : null,
        // Context for the reader: where our multiple sits vs the stock's own history + its peers.
        historical_median_multiple: hist.length ? _round2(median(hist)) : null,
        peer_median_multiple: peers.length ? _round2(median(peers)) : null,
    }
}
