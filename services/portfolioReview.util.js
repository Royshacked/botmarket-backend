// Pure helpers for the portfolio review lifecycle — no I/O, no DB.
//
// A review is a delta operation anchored to the thesis, but the book's "then" state
// (the regime, book value, and benchmark price it was last reviewed / constructed in)
// isn't recoverable after the fact. buildFingerprint captures that compact "then" so the
// next review can compute real deltas (benchmark-relative return, regime shift, drift)
// instead of re-reasoning from scratch. benchmarkTicker resolves the mandate's free-text
// benchmark to a tradeable proxy so a return can actually be computed against it.

// Free-text mandate benchmark → a tradeable ETF proxy. Order matters (most specific first).
const BENCHMARK_MAP = [
    [/russell\s*2000|small.?cap|\brut\b|\biwm\b/i, 'IWM'],
    [/nasdaq|\bndx\b|\bqqq\b/i,                    'QQQ'],
    [/dow|djia|\bdia\b/i,                          'DIA'],
    [/total\s*(stock\s*)?market|wilshire|\bvti\b/i,'VTI'],
    [/msci\s*world|\bacwi\b|global\s*equit/i,      'ACWI'],
    [/60\s*\/?\s*40|balanced/i,                    'AOR'],   // iShares Core Growth 60/40 proxy
    [/s\s*&?\s*p\s*500|\bspx\b|\bspy\b|standard\s*&?\s*poor/i, 'SPY'],
]

/**
 * Resolve a mandate benchmark (e.g. "S&P 500", "60/40", "QQQ", "absolute return") to an ETF
 * ticker we can price, or null when there's no tradeable proxy (absolute-return / cash / unknown).
 */
export function benchmarkTicker(benchmark) {
    const s = String(benchmark ?? '').trim()
    if (!s) return null
    if (/absolute\s*return|\bcash\b|\bnone\b/i.test(s)) return null
    for (const [re, tk] of BENCHMARK_MAP) if (re.test(s)) return tk
    if (/^[A-Za-z]{1,5}$/.test(s)) return s.toUpperCase()   // a bare ticker
    return null
}

/**
 * Compact "then" snapshot of a portfolio, stored on the doc and read by the next review.
 * Pure — takes already-fetched inputs.
 *
 * @param {object}  args
 * @param {'construction'|'review'} args.reason
 * @param {object|null} args.state     computePortfolioState() output (or null)
 * @param {object|null} args.macroRaw  getMacroRaw() output (or null)
 * @param {{ticker:string, price:(number|null)}|null} args.benchmark
 * @param {number} [args.now]          epoch ms (injectable for tests)
 */
export function buildFingerprint({ reason, state = null, macroRaw = null, benchmark = null, now = Date.now() }) {
    const holdings = (Array.isArray(state?.ideas) ? state.ideas : []).map(s => ({
        asset:           s.asset ?? null,
        allocationRatio: s.allocationRatio ?? null,
        actualWeight:    s.actualWeight ?? null,
        convictionScore: s.conviction?.score ?? null,
        convictionLevel: s.conviction?.level ?? null,
    }))
    return {
        capturedAt:  now,
        reason,
        bookValue:   Number.isFinite(state?.totalNotional) ? state.totalNotional : 0,
        totalPnl:    Number.isFinite(state?.totalPnl)    ? state.totalPnl    : null,
        totalPnlPct: Number.isFinite(state?.totalPnlPct) ? state.totalPnlPct : null,
        benchmark:   (benchmark && benchmark.ticker)
            ? { ticker: benchmark.ticker, price: Number.isFinite(benchmark.price) ? benchmark.price : null }
            : null,
        regime: macroRaw
            ? {
                spread2s10s: macroRaw.spread2s10s ?? null,
                fedFunds:    macroRaw.fedFunds ?? null,
                inflation:   macroRaw.inflation ?? null,
                leaders:     Array.isArray(macroRaw.leaders) ? macroRaw.leaders : [],
                asOf:        macroRaw.asOf ?? null,
            }
            : null,
        holdings,
    }
}
