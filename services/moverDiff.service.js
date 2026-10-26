// WHAT TELLS AN UP MOVER FROM A DOWN MOVER (Roy, 2026-10-25: "let's see what differs the up movers from the down
// movers"). The winners study (screenerLab winnersStudy) set the movers against everyone, and every trait that came
// before a big up week came before a big down week as often. Here the two are set against EACH OTHER: every name-week
// that beat SPY by `min`% or more (bought at Monday's open, out at the week's last close, after the cost — screenerLab
// trade) against every one that lagged it by as much, on a wide set of facts known at Monday's open.
//
// THE DISCIPLINE (screener-lab.md §6): the bins are cut, and the model fitted, on the weeks BEFORE `splitAt`; the weeks
// from it are HELD OUT and only scored. A fact that tells up from down in one period and not the other is noise.
//
// Pure: the lab's data in (screenerLab.data), no IO.

import { trade, testable, labWeeks } from './screenerLab.service.js'
import { beatSurprise } from './hotlistBacktest.service.js'

const _r = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
const _mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const _pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)

/** The facts, in the order they print — each known by Monday's open. */
export const FEATURES = Object.freeze([
    'gap_open', 'ret_fri', 'fri_close_pos', 'ret5', 'ret20', 'ret60', 'rs5', 'rs20', 'up_days5',
    'vs_sma20', 'vs_sma50', 'vs_sma200', 'pos60', 'from_high252', 'volatility', 'vol_ratio', 'adv_log', 'price_log',
    'report_in_week', 'days_since_report', 'last_surprise', 'last_reaction', 'beats_last3',
    'sector_ret5', 'vs_sector5', 'spy_ret5', 'spy_over200',
])

/**
 * One name's facts at Monday's open: `j` the Friday bar, `i0`/`i1` the week's first and last. → `{ feature: number|null }`.
 * Pure.
 */
export function featuresAt(s, data, j, i0, i1) {
    const { rows, ind, reports } = s
    const c = rows[j].close, at = (k) => (k >= 0 ? rows[k].close : null)
    const spyF = data.spyByDay.get(ind.date[j]), spy5 = data.spyByDay.get(ind.date[j - 5]), spy20 = data.spyByDay.get(ind.date[j - 20])
    const rs = (n, sp) => (at(j - n) && sp ? _pct(c, at(j - n)) - _pct(spyF?.close, sp.close) : null)
    let up = 0
    for (let k = j - 4; k <= j; k++) if (k >= 1 && rows[k].close > rows[k - 1].close) up++
    // The reports: one inside the week (its date is announced weeks ahead), the last one before Monday.
    let inWeek = 0
    for (let k = i0; k <= i1; k++) if (reports.has(ind.date[k])) inWeek = 1
    const dates = s.reportDates ??= [...reports.keys()].sort()
    const past = dates.filter(d => d <= ind.date[j])
    const last = past.at(-1) ?? null
    let sinceReport = null, surprise = null, reaction = null
    if (last) {
        const k = ind.date.indexOf(last)
        sinceReport = k >= 0 ? j - k : null
        const b = reports.get(last), a = Number(b?.epsActual), e = Number(b?.epsEstimated)
        surprise = b?.epsActual != null && b?.epsEstimated != null && Number.isFinite(a) && Number.isFinite(e) && e !== 0 ? Math.max(-100, Math.min(100, ((a - e) / Math.abs(e)) * 100)) : null
        // The reaction: the close before the report to the close of the session after (before or after the bell).
        reaction = k >= 1 && k + 1 <= j ? _pct(rows[k + 1].close, rows[k - 1].close) : null
    }
    const last3 = past.slice(-3).map(d => reports.get(d)).filter(r => r?.epsActual != null && r?.epsEstimated != null)
    const sec = data.sectorDay?.get(ind.date[j])?.get(s.sector)
    const d = rows[j], hi = ind.hi60[j], lo = ind.lo60[j]
    return {
        gap_open: _pct(rows[i0].open, c),
        ret_fri: _pct(c, at(j - 1)),
        fri_close_pos: d.high > d.low ? (d.close - d.low) / (d.high - d.low) : null,
        ret5: ind.ret5[j], ret20: _pct(c, at(j - 20)), ret60: _pct(c, at(j - 60)),
        rs5: rs(5, spy5), rs20: rs(20, spy20), up_days5: up,
        vs_sma20: _pct(c, ind.sma20[j]), vs_sma50: _pct(c, ind.sma50[j]), vs_sma200: _pct(c, ind.sma200[j]),
        pos60: hi != null && hi > lo ? (c - lo) / (hi - lo) : null,
        from_high252: _pct(c, ind.high252[j]),
        volatility: ind.sd20[j] != null && ind.sma20[j] > 0 ? (ind.sd20[j] / ind.sma20[j]) * 100 : null,
        vol_ratio: (() => {
            if (j < 50) return null
            const v = (a, b) => _mean(rows.slice(a, b).map(x => x.volume || 0))
            const v50 = v(j - 49, j + 1)
            return v50 > 0 ? v(j - 4, j + 1) / v50 : null
        })(),
        adv_log: ind.adv20[j] > 0 ? Math.log10(ind.adv20[j]) : null,
        price_log: c > 0 ? Math.log10(c) : null,
        report_in_week: inWeek, days_since_report: sinceReport, last_surprise: surprise, last_reaction: reaction,
        beats_last3: last3.length === 3 ? last3.filter(r => beatSurprise(r) || Number(r.epsActual) > Number(r.epsEstimated)).length : null,
        sector_ret5: sec?.median ?? null, vs_sector5: sec && ind.ret5[j] != null ? ind.ret5[j] - sec.median : null,
        spy_ret5: spyF && spy5 ? _pct(spyF.close, spy5.close) : null,
        spy_over200: (data.regimes?.get(ind.date[j]) ?? '').startsWith('SPY over') ? 1 : (data.regimes?.has(ind.date[j]) ? 0 : null),
    }
}

/** A mover's facts packed in FEATURES order (NaN for none) — a daily run holds ~200k of them. Pure. */
export const pack = (f) => Float32Array.from(FEATURES, k => (Number.isFinite(f[k]) ? f[k] : NaN))

/**
 * The movers → `[{ week, symbol, up, net, x }]` — `up` true for a name `min`% or more over SPY, false for one `min`% or
 * more under; everything between is left out; `x` its facts (pack). `week` is the entry session: Monday's, over the last
 * `weeks` weeks — or, `daily` (Roy, 2026-10-25: "do this test every day"), EVERY session over the last `weeks` weeks,
 * held `hold` sessions. Pure.
 */
export function collectMovers(data, { weeks = 150, min = 5, daily = false, hold = 5 } = {}) {
    const out = []
    const spans = labWeeks(data.spyDays, weeks)
    const entries = daily ? spans.flat() : spans.map(ds => ds[0])
    const last = new Map(spans.map(ds => [ds[0], ds.at(-1)]))
    for (const [symbol, s] of data.names) {
        const at = new Map(s.ind.date.map((d, i) => [d, i]))
        for (const day of entries) {
            const i0 = at.get(day)
            const i1 = daily ? i0 + hold - 1 : at.get(last.get(day))
            if (i0 == null || i0 < 61 || i1 == null || i1 < i0 || i1 >= s.rows.length || !testable(s.rows, i0, s.ind)) continue
            const t = trade({ rows: s.rows, i: i0, ind: s.ind, hold: i1 - i0 + 1, spyByDay: data.spyByDay })
            if (!t || Math.abs(t.net) < min) continue
            out.push({ week: day, symbol, up: t.net > 0, net: _r(t.net), x: pack(featuresAt(s, data, i0 - 1, i0, i1)) })
        }
    }
    return out
}

/**
 * Per feature: five bins cut on the movers before `splitAt` (its quintiles), the share that went UP in each bin, before
 * and held out → `{ feature: { cuts, bins: [{ before: {n, up}, held: {n, up} }], spread_before, spread_held } }`;
 * `spread` the top bin's up-share less the bottom's (points). A feature whose spread keeps its sign and size held out
 * tells something. `features` the names of `x`'s slots (FEATURES by default; the report test passes its own). Pure.
 */
export function binByFeature(movers, splitAt, features = FEATURES) {
    const out = {}
    for (const [fi, k] of features.entries()) {
        const vals = movers.filter(m => m.week < splitAt && Number.isFinite(m.x[fi])).map(m => m.x[fi]).sort((a, b) => a - b)
        if (vals.length < 50) continue
        // Distinct cuts: a 0/1 feature has two bins, not five.
        const cuts = [...new Set([0.2, 0.4, 0.6, 0.8].map(q => vals[Math.floor(q * (vals.length - 1))]))]
        const bin = (v) => { const b = cuts.findIndex(c => v <= c); return b === -1 ? cuts.length : b }
        const bins = Array.from({ length: cuts.length + 1 }, () => ({ before: { n: 0, up: 0 }, held: { n: 0, up: 0 } }))
        for (const m of movers) {
            const v = m.x[fi]
            if (!Number.isFinite(v)) continue
            const g = bins[bin(v)][m.week < splitAt ? 'before' : 'held']
            g.n++
            if (m.up) g.up++
        }
        const share = (g) => (g.n ? (g.up / g.n) * 100 : null)
        const used = bins.filter(b => b.before.n)
        out[k] = {
            cuts: cuts.map(c => _r(c)),
            bins: bins.map(b => ({ before: { n: b.before.n, up: _r(share(b.before), 1) }, held: { n: b.held.n, up: _r(share(b.held), 1) } })),
            spread_before: used.length > 1 ? _r(share(used.at(-1).before) - share(used[0].before), 1) : null,
            spread_held: used.length > 1 && used.at(-1).held.n && used[0].held.n ? _r(share(used.at(-1).held) - share(used[0].held), 1) : null,
        }
    }
    return out
}

/**
 * ALL THE FACTS TOGETHER: a logistic regression of up-vs-down, fitted on the movers before `splitAt` (standardized on
 * them; a missing value is the mean), scored on the held-out ones. → `{ weights, held: { n, auc, deciles: [{ n, up,
 * net_mean }] } }` — `auc` 0.5 is no better than a coin; the deciles from the model's least to its most bullish. Pure.
 */
export function fitAndScore(movers, splitAt, { epochs = 300, rate = 0.1, l2 = 0.001, features = FEATURES } = {}) {
    const train = movers.filter(m => m.week < splitAt), test = movers.filter(m => m.week >= splitAt)
    const mu = {}, sd = {}
    for (const [fi, k] of features.entries()) {
        const xs = train.map(m => m.x[fi]).filter(Number.isFinite)
        mu[k] = _mean(xs) ?? 0
        const v = xs.length > 1 ? xs.reduce((s, x) => s + (x - mu[k]) ** 2, 0) / (xs.length - 1) : 1
        sd[k] = Math.sqrt(v) || 1
    }
    // Clipped at ±4 sd: one 900% week would otherwise steer the fit.
    const vec = (m) => features.map((k, fi) => Math.max(-4, Math.min(4, Number.isFinite(m.x[fi]) ? (m.x[fi] - mu[k]) / sd[k] : 0)))
    const X = train.map(vec), y = train.map(m => (m.up ? 1 : 0))
    const w = new Array(features.length).fill(0)
    let b = 0
    const sig = (z) => 1 / (1 + Math.exp(-z))
    for (let e = 0; e < epochs; e++) {
        const g = new Array(w.length).fill(0)
        let gb = 0
        for (let n = 0; n < X.length; n++) {
            const p = sig(b + X[n].reduce((s, x, k) => s + x * w[k], 0)), d = p - y[n]
            gb += d
            for (let k = 0; k < w.length; k++) g[k] += d * X[n][k]
        }
        b -= rate * gb / X.length
        for (let k = 0; k < w.length; k++) w[k] -= rate * (g[k] / X.length + l2 * w[k])
    }
    const score = (m) => b + vec(m).reduce((s, x, k) => s + x * w[k], 0)
    const scored = test.map(m => ({ s: score(m), up: m.up, net: m.net, day: m.week })).sort((a, z) => a.s - z.s)
    // AUC by ranks: the chance a random up mover scores over a random down mover.
    let rankSum = 0, nUp = 0
    scored.forEach((x, r) => { if (x.up) { rankSum += r + 1; nUp++ } })
    const nDn = scored.length - nUp
    const auc = nUp && nDn ? (rankSum - nUp * (nUp + 1) / 2) / (nUp * nDn) : null
    const deciles = Array.from({ length: 10 }, (_, d) => {
        const xs = scored.slice(Math.floor(d * scored.length / 10), Math.floor((d + 1) * scored.length / 10))
        // Each entry session once (its names move together): the up-share per session, averaged.
        const byDay = new Map()
        for (const x of xs) { if (!byDay.has(x.day)) byDay.set(x.day, []); byDay.get(x.day).push(x.up ? 1 : 0) }
        return { n: xs.length, up: _r((xs.filter(x => x.up).length / (xs.length || 1)) * 100, 1),
            up_per_session: _r(_mean([...byDay.values()].map(v => _mean(v))) * 100, 1), sessions: byDay.size, net_mean: _r(_mean(xs.map(x => x.net))) }
    })
    return {
        weights: Object.fromEntries(features.map((k, i) => [k, _r(w[i], 3)]).sort((a, z) => Math.abs(z[1]) - Math.abs(a[1]))),
        train: train.length, held: { n: test.length, auc: _r(auc, 3), deciles },
    }
}

/**
 * THE WEEK AFTER (Roy, 2026-10-25: "the names that went up 5% — what happens to them in the following week"). Over the
 * last `weeks` weeks: each name's week (Monday's open → the week's last close, net vs SPY — trade), then its NEXT week
 * the same way. → `{ groups: { label: { n, weeks, next_mean, next_week_mean, ci95, next_median, next_up } } }`; groups:
 * every name, the up movers (`min`%+), by the size of the move, by a report inside it, by where the week closed in its
 * range (the top fifth — strong into the close — or under), and the down movers. Each WEEK counted once in the range.
 * `hold` (sessions; Roy, 2026-10-25: "a week, 2 weeks, 3 weeks, a month") — held that long from the next Monday's open
 * instead of to that week's close; the range is then over non-overlapping blocks of weeks as long as the hold. Pure.
 */
export function followThrough(data, { weeks = 52, min = 5, hold = null } = {}) {
    const spans = labWeeks(data.spyDays, weeks + 1)
    const rows = []
    for (const [symbol, s] of data.names) {
        const at = new Map(s.ind.date.map((d, i) => [d, i]))
        for (let w = 0; w + 1 < spans.length; w++) {
            const a = spans[w], b = spans[w + 1]
            const i0 = at.get(a[0]), i1 = at.get(a.at(-1)), k0 = at.get(b[0]), k1 = hold ? (k0 == null ? null : k0 + hold - 1) : at.get(b.at(-1))
            if ([i0, i1, k0, k1].some(x => x == null) || i0 < 1 || !testable(s.rows, i0, s.ind) || !testable(s.rows, k0, s.ind)) continue
            const t = trade({ rows: s.rows, i: i0, ind: s.ind, hold: i1 - i0 + 1, spyByDay: data.spyByDay })
            const n = trade({ rows: s.rows, i: k0, ind: s.ind, hold: k1 - k0 + 1, spyByDay: data.spyByDay })
            if (!t || !n) continue
            let report = false
            for (let k = i0; k <= i1; k++) if (s.reports.has(s.ind.date[k])) report = true
            let hi = -Infinity, lo = Infinity
            for (let k = i0; k <= i1; k++) { hi = Math.max(hi, s.rows[k].high); lo = Math.min(lo, s.rows[k].low) }
            const closePos = hi > lo ? (s.rows[i1].close - lo) / (hi - lo) : null
            rows.push({ week: a[0], symbol, net: t.net, next: n.net, report, closePos, gapNext: _pct(s.rows[k0].open, s.rows[i1].close) })
        }
    }
    const stats = (xs) => {
        if (!xs.length) return { n: 0 }
        const byWeek = new Map()
        for (const x of xs) { if (!byWeek.has(x.week)) byWeek.set(x.week, []); byWeek.get(x.week).push(x.next) }
        // Weeks in order, cut in blocks as long as the hold: neighbouring weeks' holds overlap.
        const per = [...byWeek.entries()].sort((p, q) => p[0].localeCompare(q[0])).map(([, v]) => _mean(v))
        const blk = Math.max(1, Math.ceil((hold ?? 5) / 5))
        const means = []
        for (let k = 0; k < per.length; k += blk) means.push(_mean(per.slice(k, k + blk)))
        const m = _mean(means), sd = means.length > 1 ? Math.sqrt(means.reduce((s, x) => s + (x - m) ** 2, 0) / (means.length - 1)) : null
        const sorted = xs.map(x => x.next).sort((p, q) => p - q)
        return { n: xs.length, weeks: per.length, blocks: means.length, next_mean: _r(_mean(xs.map(x => x.next))), next_week_mean: _r(m),
            ci95: sd != null ? [_r(m - 1.96 * sd / Math.sqrt(means.length)), _r(m + 1.96 * sd / Math.sqrt(means.length))] : null,
            next_median: _r(sorted[Math.floor(sorted.length / 2)]), next_up: _r((xs.filter(x => x.next > 0).length / xs.length) * 100, 1) }
    }
    const up = rows.filter(x => x.net >= min)
    return {
        weeks: spans.length - 1, min,
        groups: {
            'every name': stats(rows),
            [`up ${min}%+`]: stats(up),
            [`  up ${min}-10%`]: stats(up.filter(x => x.net < 10)),
            '  up 10-20%': stats(up.filter(x => x.net >= 10 && x.net < 20)),
            '  up 20%+': stats(up.filter(x => x.net >= 20)),
            '  with a report in it': stats(up.filter(x => x.report)),
            '  no report': stats(up.filter(x => !x.report)),
            '  closed in the top fifth of its week': stats(up.filter(x => x.closePos >= 0.8)),
            '  closed under it': stats(up.filter(x => x.closePos != null && x.closePos < 0.8)),
            '  gapped up again into the next week': stats(up.filter(x => x.gapNext > 1)),
            '  gapped down into it': stats(up.filter(x => x.gapNext < -1)),
            [`down ${min}%+`]: stats(rows.filter(x => x.net <= -min)),
            '  down 20%+': stats(rows.filter(x => x.net <= -20)),
        },
    }
}
