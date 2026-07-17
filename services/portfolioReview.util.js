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

const _round2 = v => Number(Number(v).toFixed(2))

const _CONVICTION_RANK = { low: 1, medium: 2, high: 3 }
const _convictionFell = (prev, cur) => {
    const p = _CONVICTION_RANK[prev?.level], c = _CONVICTION_RANK[cur?.level]
    return Number.isFinite(p) && Number.isFinite(c) && c < p
}
const _SEVERITY_ORDER = { high: 0, medium: 1 }

/**
 * Cheap, NON-LLM pre-check for the scheduled-review nudge: what (if anything) changed since the
 * fingerprint that's worth a look. Pure — takes the current state + fingerprint + the already-
 * computed reviewDelta. Returns triggers ordered high→medium (empty = quiet cycle).
 *
 * @returns {Array<{kind:string, severity:'high'|'medium', label:string}>}
 */
export function computeReviewTriggers({ state = null, fingerprint = null, delta = null, now = Date.now(), driftThreshold = 0.10, benchmarkLagThreshold = 3 } = {}) {
    const triggers = []
    const ideas = Array.isArray(state?.ideas) ? state.ideas : []

    // Conviction fell on any holding (highest-signal early warning).
    const fell = ideas.filter(s => _convictionFell(s.convictionPrev, s.conviction))
    if (fell.length) triggers.push({ kind: 'conviction', severity: 'high', label: `conviction fell on ${fell.map(s => s.asset).join(', ')}` })

    // Regime shift since the book was last reviewed.
    if (delta?.regime?.inversionFlip) {
        triggers.push({ kind: 'regime', severity: 'high', label: 'yield-curve inversion flipped since last review' })
    } else if ((delta?.regime?.rotatedIn?.length ?? 0) >= 2) {
        triggers.push({ kind: 'regime', severity: 'medium', label: `sector leadership rotated — ${delta.regime.rotatedIn.slice(0, 2).join(', ')} now leading` })
    }

    // Worst drift beyond the band.
    const worstDrift = ideas
        .filter(s => s.actualWeight != null && s.drift != null)
        .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))[0]
    if (worstDrift && Math.abs(worstDrift.drift) >= driftThreshold) {
        triggers.push({ kind: 'drift', severity: 'medium', label: `${worstDrift.asset} drifted ${worstDrift.drift > 0 ? '+' : ''}${Math.round(worstDrift.drift * 100)}pt from target` })
    }

    // Trailing the benchmark by a meaningful margin.
    const rel = delta?.benchmark?.relativePct
    if (rel != null && rel <= -benchmarkLagThreshold) {
        triggers.push({ kind: 'benchmark', severity: 'medium', label: `trailing ${delta.benchmark.ticker} by ${Math.abs(rel).toFixed(1)}pt` })
    }

    // Earnings imminent (gap risk) — from the forward calendar already in state.
    const soon = ideas.filter(s => {
        const t = s.upcomingEarnings?.date ? Date.parse(s.upcomingEarnings.date) : NaN
        if (!Number.isFinite(t)) return false
        const days = Math.floor((t - now) / 86400000)
        return days >= 0 && days <= 7
    })
    if (soon.length) triggers.push({ kind: 'earnings', severity: 'medium', label: `earnings within 7d: ${soon.map(s => s.asset).join(', ')}` })

    return triggers.sort((a, b) => _SEVERITY_ORDER[a.severity] - _SEVERITY_ORDER[b.severity])
}

/**
 * Compute the review-window delta between a stored fingerprint (the "then") and now: how the
 * book fared vs its benchmark, and how the macro regime shifted. Pure — takes the current
 * benchmark price and macro read as inputs. Returns null when there's nothing to compare
 * (no fingerprint, or neither benchmark nor regime can be resolved).
 *
 * Benchmark return over the window is exact ((now−then)/then); the book leg is the change in
 * unrealized P&L% (a two-point proxy — exact for a book that didn't trade mid-window, which is
 * the norm between reviews). relativePct = bookDeltaPnlPct − benchmarkReturnPct.
 *
 * @param {object}  args
 * @param {object|null} args.fingerprint   lastFingerprint (the "then")
 * @param {object|null} args.state         current computePortfolioState() output
 * @param {number|null} args.benchmarkNowPrice  live price of the benchmark ticker
 * @param {object|null} args.macroNow      current getMacroRaw() output
 * @param {number} [args.now]              epoch ms (injectable for tests)
 */
export function computeReviewDelta({ fingerprint = null, state = null, benchmarkNowPrice = null, macroNow = null, now = Date.now() }) {
    if (!fingerprint) return null
    const windowDays = Number.isFinite(fingerprint.capturedAt)
        ? Math.max(0, Math.round((now - fingerprint.capturedAt) / 86400000))
        : null

    // ── Benchmark-relative ──
    let benchmark = null
    const bTicker   = fingerprint.benchmark?.ticker ?? null
    const thenPrice = fingerprint.benchmark?.price ?? null
    if (bTicker && Number.isFinite(thenPrice) && thenPrice > 0 && Number.isFinite(benchmarkNowPrice) && benchmarkNowPrice > 0) {
        const returnPct = ((benchmarkNowPrice - thenPrice) / thenPrice) * 100
        const thenPnl = fingerprint.totalPnlPct
        const nowPnl  = state?.totalPnlPct
        const bookDeltaPnlPct = (Number.isFinite(thenPnl) && Number.isFinite(nowPnl)) ? nowPnl - thenPnl : null
        benchmark = {
            ticker: bTicker,
            thenPrice, nowPrice: benchmarkNowPrice,
            returnPct:       _round2(returnPct),
            bookDeltaPnlPct: bookDeltaPnlPct != null ? _round2(bookDeltaPnlPct) : null,
            relativePct:     bookDeltaPnlPct != null ? _round2(bookDeltaPnlPct - returnPct) : null,
        }
    }

    // ── Regime then → now ──
    let regime = null
    const rThen = fingerprint.regime
    if (rThen && macroNow) {
        const leadersThen = Array.isArray(rThen.leaders) ? rThen.leaders : []
        const leadersNow  = Array.isArray(macroNow.leaders) ? macroNow.leaders : []
        const spreadThen = rThen.spread2s10s, spreadNow = macroNow.spread2s10s
        regime = {
            spread2s10s: { then: spreadThen ?? null, now: spreadNow ?? null },
            fedFunds:    { then: rThen.fedFunds ?? null, now: macroNow.fedFunds ?? null },
            inflation:   { then: rThen.inflation ?? null, now: macroNow.inflation ?? null },
            inversionFlip: (Number.isFinite(spreadThen) && Number.isFinite(spreadNow)) ? (spreadThen < 0) !== (spreadNow < 0) : false,
            leadersThen, leadersNow,
            rotatedIn:  leadersNow.filter(x => !leadersThen.includes(x)),
            rotatedOut: leadersThen.filter(x => !leadersNow.includes(x)),
        }
    }

    if (!benchmark && !regime) return null
    return { windowDays, capturedAt: fingerprint.capturedAt ?? null, reason: fingerprint.reason ?? null, benchmark, regime }
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
