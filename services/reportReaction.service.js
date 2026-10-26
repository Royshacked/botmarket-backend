// CAN THE REPORT ITSELF BE TRADED? (Roy, 2026-10-26: "after a report we have a prediction of the next one, the analysts'
// pricing, the news between — so in some cases the run-up can also trade the report"). The run-up (screener-lab.md §6)
// gets out at the close before the report; holding THROUGH it had the same mean at twice the spread. So the question is
// whether what is known that evening tells which way the REACTION goes — not the beat (most names beat), the price.
//
// THE REACTION: the close the session before the report date to the close the session after it, against SPY — it holds
// the move whether the report came before the open or after the close (the bell is unknown). It is exactly what holding
// through adds to the run-up, so it needs no second cost.
//
// THE DISCIPLINE (screener-lab.md §6, moverDiff): the bins are cut, and the model fitted, on the reports before
// `splitAt`; the reports from it are HELD OUT and only scored.
//
// Pure: the lab's data in (screenerLab.data, with the `history`, `grades` and `targets` extras), no IO.

import { testable } from './screenerLab.service.js'
import { beatSurprise } from './hotlistBacktest.service.js'

const _r = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
const _pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)
const _surprise = (a, e) => (Number.isFinite(a) && Number.isFinite(e) && e !== 0 ? Math.max(-200, Math.min(200, ((a - e) / Math.abs(e)) * 100)) : null)
const _addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** The facts known the evening before a report, in the order they print. */
export const REPORT_FEATURES = Object.freeze([
    'beats3',            // of the last three reports, how many beat (hotlistBacktest beatSurprise)
    'last_surprise',     // the last report's EPS surprise, %
    'last_rev_surprise', // and its revenue surprise, %
    'last_reaction',     // the last report's own reaction against SPY, %
    'exp_growth',        // this report's EPS estimate against the actual a year before, %
    'ret5', 'ret20',     // the run into it against SPY, %
    'spy_over200',       // the market over its 200-day (1/0)
    'net_upgrades60',    // upgrades less downgrades in the 60 days before
    'pt_net45',          // price-target raises less cuts in the 45 days before
    'pt_count45',        // how many price-target notes (attention)
    'pt_upside',         // the median target over the price when posted, the 90 days before, %
    'vol5x',             // the last five sessions' dollar volume over the 20-day average before them
])

/** The reaction to the report on bar `k`: close k−1 → close k+1, less SPY's. Null at the edges or a missing SPY bar. Pure. */
export function reactionAt(s, k, data) {
    if (k < 1 || k + 1 >= s.rows.length) return null
    const a = data.spyByDay.get(s.ind.date[k - 1]), b = data.spyByDay.get(s.ind.date[k + 1])
    if (!(a?.close > 0) || !(b?.close > 0)) return null
    return _pct(s.rows[k + 1].close, s.rows[k - 1].close) - _pct(b.close, a.close)
}

/** The run of the `n` sessions to the close of bar `j`, against SPY's. Pure. */
function runTo(s, j, n, data) {
    if (j - n < 0) return null
    const a = data.spyByDay.get(s.ind.date[j - n]), b = data.spyByDay.get(s.ind.date[j])
    if (!(a?.close > 0) || !(b?.close > 0)) return null
    return _pct(s.rows[j].close, s.rows[j - n].close) - _pct(b.close, a.close)
}

const _median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }

/**
 * The facts for the report dated `day` on bar `k` → `{ feature: value }` (null where unknown), from what was known by the
 * close of k−1. `priors` the name's earlier reports with an actual, oldest first. Pure.
 */
export function reportFeatures(s, k, day, priors, data, spyOver200) {
    const last = priors.at(-1), last3 = priors.slice(-3)
    const lastK = last ? s.ind.date.indexOf(last.date) : -1
    const cur = s.reports.get(day), yearAgo = priors.length >= 4 ? priors.at(-4) : null
    const inDays = (rows, n) => rows.filter(r => r[0] >= _addDays(day, -n) && r[0] < day)
    const g60 = inDays(s.grades ?? [], 60), t45 = inDays(s.targets ?? [], 45), t90 = inDays(s.targets ?? [], 90)
    const adv = s.ind.adv20[k - 6]
    let vol5 = 0
    for (let j = k - 5; j <= k - 1; j++) vol5 += s.rows[j].close * (s.rows[j].volume || 0)
    return {
        beats3: last3.length === 3 ? last3.filter(r => beatSurprise(r)).length : null,
        last_surprise: last ? _surprise(Number(last.epsActual), Number(last.epsEstimated)) : null,
        last_rev_surprise: last ? _surprise(Number(last.revenueActual), Number(last.revenueEstimated)) : null,
        last_reaction: lastK > 0 ? reactionAt(s, lastK, data) : null,
        exp_growth: yearAgo ? _surprise(Number(cur?.epsEstimated), Number(yearAgo.epsActual)) : null,
        ret5: runTo(s, k - 1, 5, data), ret20: runTo(s, k - 1, 20, data),
        spy_over200: spyOver200.get(s.ind.date[k - 1]) ?? null,
        net_upgrades60: g60.filter(g => g[1] === 'upgrade').length - g60.filter(g => g[1] === 'downgrade').length,
        pt_net45: t45.reduce((a, t) => a + (t[3] ?? 0), 0),
        pt_count45: t45.length,
        pt_upside: _median(t90.filter(t => t[1] > 0 && t[2] > 0).map(t => (t[1] / t[2] - 1) * 100)),
        vol5x: adv > 0 ? vol5 / 5 / adv : null,
    }
}

/** SPY over its 200-day, by session → Map(day → 1/0). Pure. */
export function spyOver200(data) {
    const out = new Map()
    let sum = 0
    const closes = data.spyDays.map(d => data.spyByDay.get(d).close)
    closes.forEach((c, i) => {
        sum += c
        if (i >= 200) sum -= closes[i - 200]
        if (i >= 199) out.set(data.spyDays[i], c > sum / 200 ? 1 : 0)
    })
    return out
}

/**
 * Every report from `from` to `to` → `[{ week, symbol, up, net, f, x, rule }]` in moverDiff's shape (`week` the report
 * day, `up`/`net` its reaction, `x` the facts packed in REPORT_FEATURES order) — so binByFeature and fitAndScore read it
 * as they read the movers. `rule` the run-up's own gate (the last three beat, SPY over its 200-day). Only reports on a
 * trading day, testable the evening before, with 60 sessions of history. Pure.
 */
export function collectReports(data, { from, to } = {}) {
    const over = spyOver200(data)
    const out = []
    for (const [symbol, s] of data.names) {
        const dates = [...s.reports.keys()].sort()
        const at = new Map(s.ind.date.map((d, i) => [d, i]))
        for (const day of dates) {
            if ((from && day < from) || (to && day > to)) continue
            const k = at.get(day)
            if (k == null || k < 61 || !testable(s.rows, k, s.ind)) continue
            const net = reactionAt(s, k, data)
            if (net == null) continue
            const priors = dates.filter(d => d < day).map(d => s.reports.get(d)).filter(r => r?.epsActual != null)
            const f = reportFeatures(s, k, day, priors, data, over)
            out.push({ week: day, symbol, up: net > 0, net: _r(net), f,
                x: Float32Array.from(REPORT_FEATURES, key => (Number.isFinite(f[key]) ? f[key] : NaN)),
                rule: f.beats3 === 3 && f.spy_over200 === 1 })
        }
    }
    return out
}

// ─── Test E: the drift AFTER a report, by its surprise (Roy, 2026-10-26: "events keep affecting prices far from the
// event date") ─────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// The classic drift is sorted by the SURPRISE (the actual against the estimate), not by the price move, and lives out to
// 60 sessions. Bought at the open of the SECOND session after the report date — the reaction window (reactionAt) is over
// by then, so the surprise AND the reaction are known — and held 20 / 40 / 60 (screenerLab trade).

/** The EPS surprise in %, the estimate floored at 5 cents (a near-zero or negative estimate would blow it up), ±100. Pure. */
export function surprisePct(report) {
    const a = Number(report?.epsActual), e = Number(report?.epsEstimated)
    if (report?.epsActual == null || report?.epsEstimated == null || !Number.isFinite(a) || !Number.isFinite(e)) return null
    return Math.max(-100, Math.min(100, ((a - e) / Math.max(Math.abs(e), 0.05)) * 100))
}

/** The surprise's band: a miss under −2%, in line to +2%, a beat to +10%, a big beat over it. Pure. */
export const surpriseBand = (pct) => (pct == null ? null : pct < -2 ? 'miss' : pct <= 2 ? 'in line' : pct <= 10 ? 'beat' : 'big beat')

/**
 * Every report from `from` with an actual → `[{ symbol, j, day, band, reacted }]` in newsShock's shape (`j` the bar the
 * trade is entered AFTER, so shockTrades buys at j + 1 = the second session after the report): `band` surpriseBand,
 * `reacted` 'up' / 'down' (the reaction's sign). Pure.
 */
export function collectDrift(data, { from, to } = {}) {
    const out = []
    for (const [symbol, s] of data.names) {
        const at = new Map(s.ind.date.map((d, i) => [d, i]))
        for (const [day, rep] of s.reports) {
            if ((from && day < from) || (to && day > to)) continue
            const k = at.get(day)
            if (k == null || k < 61) continue
            const band = surpriseBand(surprisePct(rep)), net = reactionAt(s, k, data)
            if (!band || net == null) continue
            out.push({ symbol, j: k + 1, day, band, reacted: net > 0 ? 'up' : 'down' })
        }
    }
    return out
}

// ─── Test F: the early reporters → the late one, same season (Roy, 2026-10-26: "we need to anticipate the price
// movement after earnings") ──────────────────────────────────────────────────────────────────────────────────────────
//
// Peers' PRICES read through on the day (newsShock peerRows); this asks whether their RESULTS do — whether the season's
// early reporters in an industry tell how a later one will report and react. The early reporters: the industry's other
// names with a report in the `windowDays` before the target's, whose reaction window was over by the target's evening
// before.

/** The early-reporter facts, in the order they print. */
export const PEER_FEATURES = Object.freeze(['early_surprise', 'early_beat', 'early_reaction', 'early_n'])

/**
 * Every report from `from` with `min`+ early reporters → `[{ week, symbol, up, net, x, beat, surprise, f }]` in
 * moverDiff's shape: `up`/`net` the target's reaction, `beat` its surprise over +2% (surpriseBand's line), `x` the early
 * facts packed in PEER_FEATURES order — their mean surprise (%), the share of them over +2%, their mean reaction against
 * SPY, how many. `lead` — the facts as known `lead` sessions before the report (0: its evening before's). Pure.
 */
export function peerSeason(data, industryOf, { from, to, windowDays = 45, min = 2, lead = 0 } = {}) {
    // Every report with its industry, day, the day its reaction window closed, surprise and reaction.
    const all = []
    for (const [symbol, s] of data.names) {
        const ind = industryOf.get(symbol)
        if (!ind) continue
        const at = new Map(s.ind.date.map((d, i) => [d, i]))
        for (const [day, rep] of s.reports) {
            const k = at.get(day)
            if (k == null || k < 1 || k + 1 >= s.rows.length) continue
            all.push({ symbol, ind, day, k, closed: s.ind.date[k + 1], surprise: surprisePct(rep), net: reactionAt(s, k, data) })
        }
    }
    const byInd = new Map()
    for (const r of all) { if (!byInd.has(r.ind)) byInd.set(r.ind, []); byInd.get(r.ind).push(r) }
    const out = []
    for (const r of all) {
        if ((from && r.day < from) || (to && r.day > to) || r.k < 61 || r.net == null || r.surprise == null) continue
        const s = data.names.get(r.symbol)
        if (!testable(s.rows, r.k, s.ind)) continue
        const since = _addDays(r.day, -windowDays)
        // `lead`: known that many sessions before the report (the run-up enters 5 before) — not only by its eve.
        const by = s.ind.date[r.k - lead]
        const early = byInd.get(r.ind).filter(e => e.symbol !== r.symbol && e.day >= since && e.closed < by && e.surprise != null && e.net != null)
        if (early.length < min) continue
        const f = {
            early_surprise: early.reduce((a, e) => a + e.surprise, 0) / early.length,
            early_beat: early.filter(e => e.surprise > 2).length / early.length,
            early_reaction: early.reduce((a, e) => a + e.net, 0) / early.length,
            early_n: early.length,
        }
        out.push({ week: r.day, symbol: r.symbol, up: r.net > 0, net: _r(r.net), beat: r.surprise > 2, surprise: r.surprise, f,
            x: Float32Array.from(PEER_FEATURES, key => f[key]) })
    }
    return out
}
