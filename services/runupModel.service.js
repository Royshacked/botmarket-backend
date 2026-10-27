// A MODEL ON THE RUN-UP — test K (Roy, 2026-10-27: "start with a [the model filters the run-up trades], and test also
// combination of rules"). Every run-up entry (screenerLab `runup_5`: bought 5 sessions before a report, out at the close
// before it), any streak, any market — the live rule is one combination inside it — with every fact known by the close
// before the entry. The model and the rule search read the table this builds (scripts/lab-runup-ml.py). Declared in
// screener-lab.md §27.
//
// Pure: the lab's data in (screenerLab.data, with the `history`, `grades`, `targets`, `insiders` and the FINRA extras), no IO.

import { HYPOTHESES, runHypothesis, siAsOf, dpShares } from './screenerLab.service.js'
import { FEATURES as MOVER_FEATURES, featuresAt } from './moverDiff.service.js'
import { beatSurprise } from './hotlistBacktest.service.js'

const _r = (n, d = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
const _mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const _median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
const _addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const _surprise = (a, e) => (Number.isFinite(a) && Number.isFinite(e) && e !== 0 ? Math.max(-200, Math.min(200, ((a - e) / Math.abs(e)) * 100)) : null)

/** The facts, in the order the table's columns print. moverDiff's (less `report_in_week` — always 1 on a run-up), then the test's own. */
export const RUNUP_FEATURES = Object.freeze([
    ...MOVER_FEATURES.filter(k => k !== 'report_in_week'),
    'exp_growth',        // this report's EPS estimate against the actual a year before, %
    'last_rev_surprise', // the last report's revenue surprise, %
    'net_upgrades60',    // upgrades less downgrades in the 60 days before the entry
    'pt_net45',          // price-target raises less cuts in the 45 days before
    'pt_count45',        // how many price-target notes (attention)
    'pt_upside90',       // the median target over the price when posted, the 90 days before, %
    'si_dtc',            // short interest: days to cover, the latest report safe to know (§14)
    'si_change',         // and its change against the report before, %
    'sv_delta',          // the short share of volume, the 5 sessions to the entry against the 60 before (points)
    'dp_jump',           // the latest PUBLISHED dark-pool week's share less its 8 weeks before (points, §15)
    'insider_buyers90',  // distinct insiders buying (Form 4 code P) in the 90 days before
    'season_beat_share', // of the same sector's names that reported in the 30 days before, the share that beat (%)
    'season_n',          // how many those were
    'spy_calm',          // the market's 20-day volatility at or under its year's median (1/0, spyRegimes)
])

/**
 * Per sector, every report with an actual, oldest first: `[{ day, beat }]` (beat 1/0 by hotlistBacktest beatSurprise).
 * Built once per data. Pure.
 */
export function sectorSeasons(data) {
    const out = new Map()
    for (const s of data.names.values()) {
        if (!s.sector) continue
        if (!out.has(s.sector)) out.set(s.sector, [])
        for (const [day, r] of s.reports) if (r?.epsActual != null && r?.epsEstimated != null) out.get(s.sector).push({ day, beat: beatSurprise(r) ? 1 : 0 })
    }
    for (const xs of out.values()) xs.sort((a, b) => a.day.localeCompare(b.day))
    return out
}

/** The first index in `xs` (sorted by `day`) whose day is ≥ `d`. Pure. */
function lowerBound(xs, d) {
    let lo = 0, hi = xs.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m].day < d) lo = m + 1; else hi = m }
    return lo
}

/**
 * The test's own facts for a run-up entry on bar `i` of name `s` ahead of the report dated `reportDay` → `{ feature:
 * value|null }`, from what was known by the close of `i − 1`. `seasons` from sectorSeasons. Pure.
 */
export function runupExtras(s, data, i, reportDay, seasons) {
    const day = s.ind.date[i - 1]
    const inDays = (rows, n) => (rows ?? []).filter(r => r[0] > _addDays(day, -n) && r[0] <= day)
    const g60 = inDays(s.grades, 60), t45 = inDays(s.targets, 45), t90 = inDays(s.targets, 90)
    const priors = (s.reportDates ??= [...s.reports.keys()].sort()).filter(d => d < day).map(d => s.reports.get(d)).filter(r => r?.epsActual != null)
    const last = priors.at(-1), yearAgo = priors.length >= 4 ? priors.at(-4) : null
    const cur = s.reports.get(reportDay)
    const si = siAsOf(s, day)
    // The short share of volume: the five sessions to the entry against the sixty before them, each needing most of its days.
    let svDelta = null
    if (i >= 66 && s.sv?.size) {
        const at = (a, b) => { const xs = []; for (let k = a; k < b; k++) { const v = s.sv.get(s.ind.date[k]); if (v != null) xs.push(v) } return xs }
        const recent = at(i - 5, i), base = at(i - 65, i - 5)
        if (recent.length >= 4 && base.length >= 40) svDelta = _mean(recent) - _mean(base)
    }
    const dp = s.dp?.length ? dpShares(s, s.ind).filter(x => x.published <= day).at(-1) : null
    const buyers = new Set((s.insiders ?? []).filter(b => b.filed > _addDays(day, -90) && b.filed <= day).map(b => b.who))
    // The season: the sector's reports in the 30 days to the entry's evening (each report's actual is out on its day).
    const xs = seasons.get(s.sector) ?? []
    const season = xs.slice(lowerBound(xs, _addDays(day, -29)), lowerBound(xs, _addDays(day, 1)))
    const regime = data.regimes?.get(day) ?? ''
    return {
        exp_growth: yearAgo ? _surprise(Number(cur?.epsEstimated), Number(yearAgo.epsActual)) : null,
        last_rev_surprise: last ? _surprise(Number(last.revenueActual), Number(last.revenueEstimated)) : null,
        net_upgrades60: g60.filter(g => g[1] === 'upgrade').length - g60.filter(g => g[1] === 'downgrade').length,
        pt_net45: t45.reduce((a, t) => a + (t[3] ?? 0), 0),
        pt_count45: t45.length,
        pt_upside90: _median(t90.filter(t => t[1] > 0 && t[2] > 0).map(t => (t[1] / t[2] - 1) * 100)),
        si_dtc: Number.isFinite(si?.dtc) ? si.dtc : null,
        si_change: Number.isFinite(si?.change) ? si.change : null,
        sv_delta: svDelta,
        dp_jump: dp?.jump ?? null,
        insider_buyers90: buyers.size,
        season_beat_share: season.length >= 5 ? (season.filter(x => x.beat).length / season.length) * 100 : null,
        season_n: season.length,
        spy_calm: regime ? (regime.endsWith('calm') ? 1 : 0) : null,
    }
}

/**
 * Every run-up entry from `from` → `[{ day, exit_day, symbol, sector, report_day, live, net, f }]` — `net` the trade's
 * net vs SPY after cost (screenerLab trade), `live` the live rule's own gate (3 of 3 beat, SPY over its 200-day), `f`
 * the facts (RUNUP_FEATURES). Pure.
 */
export function collectRunups(data, { from } = {}) {
    const days = data.spyDays.filter(d => !from || d >= from)
    const trades = runHypothesis(HYPOTHESES.runup_5, data, { days })
    const seasons = sectorSeasons(data)
    const out = []
    for (const t of trades) {
        const s = data.names.get(t.symbol)
        const at = s._at ??= new Map(s.ind.date.map((d, k) => [d, k]))
        const i = at.get(t.day), j1 = at.get(t.exit_day)
        if (i == null || j1 == null || i < 61) continue
        const reportDay = s.reportDates.find(d => d > s.ind.date[j1]) ?? null
        const m = featuresAt(s, data, i - 1, i, j1)
        const f = { ...Object.fromEntries(MOVER_FEATURES.filter(k => k !== 'report_in_week').map(k => [k, m[k]])), ...runupExtras(s, data, i, reportDay, seasons) }
        const live = t.tag === '3 of 3 beat' && (data.regimes?.get(s.ind.date[i - 1]) ?? '').startsWith('SPY over')
        out.push({ day: t.day, exit_day: t.exit_day, symbol: t.symbol, sector: s.sector ?? '', report_day: reportDay, live: live ? 1 : 0, net: _r(t.net), f })
    }
    return out
}

/** The table's header and one row, CSV (empty for a missing value; no field holds a comma or a quote). Pure. */
export const CSV_HEAD = ['day', 'exit_day', 'symbol', 'sector', 'report_day', 'live', 'net', ...RUNUP_FEATURES]
export const csvRow = (r) => [r.day, r.exit_day, r.symbol, String(r.sector).replace(/[,"]/g, ' '), r.report_day ?? '', r.live, r.net,
    ...RUNUP_FEATURES.map(k => (Number.isFinite(r.f[k]) ? _r(r.f[k]) : ''))].join(',')
