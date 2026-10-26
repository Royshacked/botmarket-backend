// CAN THE RUN-UP TRADE THE REPORT? — test C (services/reportReaction.service.js): what is known the evening before a
// report (the last reports, the run into it, the analysts' ratings and targets, attention) against the REACTION (close
// before → close after, vs SPY). Bins and a model cut/fitted before the split, scored on the held-out year; then the same
// on the run-up's own names (the last three beat, SPY over its 200-day) — the pass bar: a group whose reaction is clear
// of zero held out, so that holding it through pays (Roy, 2026-10-26).
//
//   node scripts/lab-report.mjs
//
// Offline: data/lab/screener-3y.json + its extras (history, grades, targets — read once, cached).
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { collectReports, REPORT_FEATURES } = await import('../services/reportReaction.service.js')
const { binByFeature, fitAndScore } = await import('../services/moverDiff.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const FROM = '2023-10-09', SPLIT = '2025-10-23'
const data = await loadLabData({ name: 'screener', years: 3, extras: ['history', 'grades', 'targets'] })
await closeDb()
const reports = collectReports(data, { from: FROM })
const s = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x}`)
const r2 = (x) => Math.round(x * 100) / 100

// A group's reaction: per name, and each report DAY once (a day's reports move together) with its 95% range.
function stats(xs) {
    if (!xs.length) return 'none'
    const by = new Map()
    for (const x of xs) { if (!by.has(x.week)) by.set(x.week, []); by.get(x.week).push(x.net) }
    const per = [...by.values()].map(v => v.reduce((a, b) => a + b, 0) / v.length)
    const m = per.reduce((a, b) => a + b, 0) / per.length
    const sd = per.length > 1 ? Math.sqrt(per.reduce((a, b) => a + (b - m) ** 2, 0) / (per.length - 1)) : 0
    const se = sd / Math.sqrt(per.length)
    const mean = xs.reduce((a, x) => a + x.net, 0) / xs.length
    return `${String(xs.length).padStart(5)} · up ${(xs.filter(x => x.up).length / xs.length * 100).toFixed(1)}% · mean ${s(r2(mean))}% · per day ${s(r2(m))}% [${s(r2(m - 1.96 * se))} … ${s(r2(m + 1.96 * se))}]`
}
const before = reports.filter(r => r.week < SPLIT), held = reports.filter(r => r.week >= SPLIT)
const cover = (k) => Math.round(reports.filter(r => Number.isFinite(r.f[k])).length / reports.length * 100)
console.log(`${reports.length} reports ${FROM} → ${reports.at(-1) ? [...reports].sort((a, b) => b.week.localeCompare(a.week))[0].week : ''}; held out from ${SPLIT}`)
console.log(`  coverage: ${REPORT_FEATURES.map(k => `${k} ${cover(k)}%`).join(' · ')}`)
console.log(`  every report   before ${stats(before)}`)
console.log(`                 held   ${stats(held)}`)
console.log(`  run-up names   before ${stats(before.filter(r => r.rule))}`)
console.log(`                 held   ${stats(held.filter(r => r.rule))}`)
const sd = (xs) => { const m = xs.reduce((a, x) => a + x.net, 0) / xs.length; return Math.sqrt(xs.reduce((a, x) => a + (x.net - m) ** 2, 0) / (xs.length - 1)).toFixed(1) }
console.log(`  the reaction's spread (sd): ${sd(reports)}%\n`)

function bins(title, list) {
    console.log(`── ${title}: share of reactions UP by quintile (cut before ${SPLIT}) — before / held out · spread top−bottom`)
    const b = binByFeature(list, SPLIT, REPORT_FEATURES)
    for (const [k, v] of Object.entries(b)) {
        console.log(`  ${k.padEnd(18)} ${v.bins.map(x => `${x.before.up ?? '—'}/${x.held.up ?? '—'}`).join('  ').padEnd(64)} spread ${s(v.spread_before)} / ${s(v.spread_held)}   cuts ${v.cuts.join(', ')}`)
    }
    console.log('')
}
bins('every report', reports)
bins('the run-up\'s names', reports.filter(r => r.rule))

function model(title, list) {
    const m = fitAndScore(list, SPLIT, { features: REPORT_FEATURES })
    console.log(`── ${title}: all the facts together, fitted on ${m.train}, scored on ${m.held.n} held out — AUC ${m.held.auc}`)
    console.log(`  weights: ${Object.entries(m.weights).map(([k, w]) => `${k} ${w}`).join(' · ')}`)
    m.held.deciles.forEach((d, i) => console.log(`  decile ${String(i + 1).padStart(2)}  n ${String(d.n).padStart(4)}  up ${d.up}% (per day ${d.up_per_session}%)  mean reaction ${s(d.net_mean)}%`))
    console.log('')
}
model('every report', reports)
model('the run-up\'s names', reports.filter(r => r.rule))

// The analysts' own signal, as a trader would read it: the run-up's names by what the analysts did before.
console.log('── the run-up\'s names by the analysts before the report — before / held out')
const rule = reports.filter(r => r.rule)
for (const [label, f] of [
    ['net upgrades > 0', r => r.f.net_upgrades60 > 0], ['net upgrades < 0', r => r.f.net_upgrades60 < 0],
    ['targets raised (net ≥ 2)', r => r.f.pt_net45 >= 2], ['targets cut (net ≤ −1)', r => r.f.pt_net45 <= -1],
    ['no target notes', r => r.f.pt_count45 === 0],
]) {
    console.log(`  ${label.padEnd(26)} before ${stats(rule.filter(r => r.week < SPLIT && f(r)))}`)
    console.log(`  ${''.padEnd(26)} held   ${stats(rule.filter(r => r.week >= SPLIT && f(r)))}`)
}
process.exit(0)
