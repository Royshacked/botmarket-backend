// Pure helpers for the portfolio review lifecycle — no I/O, no DB.
//
import { toNum } from './format.util.js'
// Pure too (forecast clock + arithmetic), so this module stays no-I/O as its header claims.
import { diffStances } from '../monitoring/tilt.assess.js'
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

// How far OUR price target must fall below the one we bought on before the book deserves a look.
// Below this is ordinary re-modelling noise; above it, the case has materially weakened.
export const PT_CUT_PCT = 15

// The SHARED coercion, not a local retype: `Number(null)` is 0, so the terse version turns a missing
// price target into a real zero — which would read as "PT 0 ≤ our entry" and ring the doorbell on
// every held name at once. That exact shape already broke the coverage book once.
const _n = toNum

/**
 * Cheap, NON-LLM pre-check for the scheduled-review nudge: what (if anything) changed since the
 * fingerprint that's worth a look. Pure — takes the current state + fingerprint + the already-
 * computed reviewDelta. Returns triggers ordered high→medium (empty = quiet cycle).
 *
 * `coverage` = the held names whose Prometheus coverage has flipped terminal (thesis_broken /
 * target_hit), resolved by the caller (a DB read — kept out of this pure fn). Each is a "look now"
 * signal in its own right. `adverseMoveThreshold` (pts) is the "nuclear war" proxy: rather than a
 * news classifier, the market's own reaction — a sharp drop in book P&L% since the fingerprint —
 * is what earns a look.
 *
 * @returns {Array<{kind:string, severity:'high'|'medium', label:string}>}
 */
export function computeReviewTriggers({ state = null, fingerprint = null, delta = null, coverage = [], tilt = null, now = Date.now(), driftThreshold = 0.10, benchmarkLagThreshold = 3, adverseMoveThreshold = 8 } = {}) {
    const triggers = []
    const ideas = Array.isArray(state?.ideas) ? state.ideas : []

    // Conviction fell on any holding (highest-signal early warning).
    const fell = ideas.filter(s => _convictionFell(s.convictionPrev, s.conviction))
    if (fell.length) triggers.push({ kind: 'conviction', severity: 'high', label: `conviction fell on ${fell.map(s => s.asset).join(', ')}` })

    // The coverage-delta gate. Research itself has no invalidation — a thesis whose price fell is
    // cheaper, not wrong — so what earns a look here is our OWN PRICE TARGET moving against a position
    // we actually hold, measured against the basis frozen when we bought it:
    //   • PT ≤ what we paid  → no upside left on our own numbers. That is the real "thesis broken".
    //   • PT cut materially since entry → the case is weakening even if it still clears cost.
    // `status` is still honoured, but only as a DELIBERATE verdict: nothing deterministic sets
    // thesis_broken any more, so its presence means the analyst tier or the user said so.
    for (const c of (Array.isArray(coverage) ? coverage : [])) {
        const pt = _n(c?.currentPt)

        if (c?.status === 'thesis_broken')  triggers.push({ kind: 'coverage', severity: 'high',   label: `${c.symbol}: research thesis broken` })
        else if (c?.status === 'target_hit') triggers.push({ kind: 'coverage', severity: 'medium', label: `${c.symbol}: research price target hit` })

        const entry = _n(c?.entryPrice)
        if (pt !== null && entry !== null && entry > 0 && pt <= entry) {
            triggers.push({ kind: 'coverage', severity: 'high', label: `${c.symbol}: our price target ${pt} is at or below our entry ${_round2(entry)} — no upside left on our own numbers` })
            continue   // the harder finding already covers the softer one
        }

        const basis = _n(c?.basisPt)
        if (pt !== null && basis !== null && basis > 0) {
            const cutPct = (basis - pt) / basis * 100
            if (cutPct >= PT_CUT_PCT) {
                triggers.push({ kind: 'coverage', severity: 'medium', label: `${c.symbol}: our price target cut ${Math.round(cutPct)}% since entry (${_round2(basis)} → ${_round2(pt)})` })
            }
        }
    }

    // "Nuclear war" proxy — a sharp adverse move in book P&L% since the fingerprint. The market's
    // reaction is the signal; no news feed needed. Two-point (then→now) like the benchmark leg.
    const nowPnl = state?.totalPnlPct, thenPnl = fingerprint?.totalPnlPct
    if (Number.isFinite(nowPnl) && Number.isFinite(thenPnl)) {
        const move = nowPnl - thenPnl
        if (move <= -adverseMoveThreshold) triggers.push({ kind: 'drawdown', severity: 'high', label: `book down ${move.toFixed(1)}pt since last look` })
    }

    // Regime shift since the book was last reviewed.
    //
    // DAILY SECTOR ROTATION IS DELIBERATELY NOT HERE (removed 2026-08-06). It fired almost every
    // day and told the reader nothing. `leaders` was the top 3 sectors by ONE DAY's percent change,
    // compared against the 3 leaders stored whenever the last review happened — three drawn from
    // eleven, twice, weeks apart. Under a random model ≥2 differ about 85% of the time, and the cut
    // between "leading" and not was routinely a few hundredths of a percent. It had no baseline
    // that could ratchet, which is the same reason it was declined as a coverage re-model trigger
    // on 2026-07-30 and should never have survived here.
    //
    // What replaces it is the HOUSE SECTOR VIEW changing — deliberate, rare, and already ratcheted
    // (Pythia publishes on a monthly floor under a cooldown). See the sector_view trigger below.
    if (delta?.regime?.inversionFlip) {
        triggers.push({ kind: 'regime', severity: 'high', label: 'yield-curve inversion flipped since last review' })
    }

    // The house sector view moved since this book was last looked at.
    //
    // NOT gated on what the book holds. A sector we own nothing in turning overweight is exactly
    // when a swap is worth considering, so filtering to current holdings would hide the most
    // actionable case — the opposite of the ownership gate the notification cards use, and
    // deliberately so: a card interrupts, a review trigger is read when the user is already looking.
    const viewMoved = diffStances({ tilts: fingerprint?.tilt?.stances }, { tilts: tilt?.tilts })
    if (viewMoved.length) {
        const named = viewMoved.slice(0, 2).map(c => `${c.sector} ${c.from ?? 'no view'}→${c.to ?? 'no view'}`).join(', ')
        const more  = viewMoved.length > 2 ? ` (+${viewMoved.length - 2} more)` : ''
        triggers.push({ kind: 'sector_view', severity: 'medium', label: `house sector view changed — ${named}${more}` })
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
        // No leaders/rotation legs. Diffing two single-day sector rankings produced a "rotation"
        // on almost every comparison; the honest version of that signal is the house view moving.
        const spreadThen = rThen.spread2s10s, spreadNow = macroNow.spread2s10s
        regime = {
            spread2s10s: { then: spreadThen ?? null, now: spreadNow ?? null },
            fedFunds:    { then: rThen.fedFunds ?? null, now: macroNow.fedFunds ?? null },
            inflation:   { then: rThen.inflation ?? null, now: macroNow.inflation ?? null },
            inversionFlip: (Number.isFinite(spreadThen) && Number.isFinite(spreadNow)) ? (spreadThen < 0) !== (spreadNow < 0) : false,
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
export function buildFingerprint({ reason, state = null, macroRaw = null, benchmark = null, tilt = null, now = Date.now() }) {
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
                asOf:        macroRaw.asOf ?? null,
            }
            : null,
        // The house sector view AS IT STOOD at this review — the baseline the next one diffs
        // against. Only the three fields a stance is judged by; the rest of the doc is Pythia's.
        tilt: tilt?.id
            ? {
                id: tilt.id,
                stances: (Array.isArray(tilt.tilts) ? tilt.tilts : [])
                    .map(r => ({ sector: r.sector, stance: r.stance ?? null, active_bp: r.active_bp ?? null })),
            }
            : null,
        holdings,
    }
}
