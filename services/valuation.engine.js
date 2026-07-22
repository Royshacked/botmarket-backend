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
 * Compute our relative-valuation price target. Returns { ok:false, reason } on unusable input, else
 * a transparent breakdown. The base multiple is the agent's `multiple` if given (the edge), else
 * derived from the stock's own history; the bear/base/bull band is a ±15% sensitivity around a
 * provided multiple, or the historical quartiles when we derive it.
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
    const toPrice = mult => {
        if (method === 'pe') return mult * fwd             // multiple × EPS = price per share
        if (shares === null || shares <= 0) return null    // ev_* needs a share count for the equity bridge
        return ((mult * fwd) - netDebt) / shares           // EV = mult×metric → equity → per share
    }
    const ptBase = toPrice(base), ptLow = toPrice(low), ptHigh = toPrice(high)
    if (ptBase === null) return { ok: false, reason: 'ev_needs_shares' }

    const consensusPt = _num(input.consensus_pt)
    const price       = _num(input.current_price)

    return {
        ok: true,
        method,
        multiple: { used: _round2(base), low: _round2(low), high: _round2(high), basis },
        forward_metric: fwd,
        pt: { bear: _round2(ptLow), base: _round2(ptBase), bull: _round2(ptHigh) },
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
