// WHERE A TREND COMES FROM — test D (services/trendSource.service.js): each name's year against SPY, cut into its
// report windows, its industry's move between reports, and its own move between reports (Roy, 2026-10-26: "events keep
// affecting prices even when far from the event date"). Three yearly windows, the last the held-out year.
//
//   node scripts/lab-trend-source.mjs [SYM …]     (named symbols also print their own rows)
//
// Offline bars (data/lab/screener-3y.json + its earnings history); industries from the latest screener stats.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const show = process.argv.slice(2).map(s => s.toUpperCase())
const { industryDaily, decompose } = await import('../services/trendSource.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { COLLECTION: STATS } = await import('../services/dailyScreener.service.js')
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const db = await getDb()
const last = await db.collection(STATS).find({}, { projection: { day: 1 } }).sort({ day: -1 }).limit(1).next()
const industryOf = new Map((await db.collection(STATS).find({ day: last.day }, { projection: { _id: 0, symbol: 1, industry: 1 } }).toArray()).filter(r => r.industry).map(r => [r.symbol, r.industry]))
const data = await loadLabData({ name: 'screener', years: 3, extras: ['history'] })
await closeDb()
const inds = industryDaily(data, industryOf)
const D = data.spyDays, n = D.length - 1
const windows = [[D[n - 756], D[n - 504]], [D[n - 504], D[n - 252]], [D[n - 252], D[n]]]
const f = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
for (const [a, b] of windows) {
    const rows = []
    for (const [symbol, s] of data.names) {
        const ind = industryOf.get(symbol)
        const i0 = s.ind.date.indexOf(a), i1 = s.ind.date.indexOf(b)
        if (!ind || i0 < 1 || i1 <= i0 || s.rows[i0].close < 5) continue
        const r = decompose(s, i0, i1, data, ind, inds)
        if (r) rows.push({ symbol, ...r })
    }
    console.log(`\n${a} → ${b}${b === D[n] ? '  (held out)' : ''} — ${rows.length} names · % log points vs SPY · report windows ${f(mean(rows.map(r => r.report_days / r.days * 100)))}% of the sessions`)
    console.log('  group                       names   total   reports  industry-between  own-between   reports' + "'" + ' share   per report day / per other day')
    for (const [label, xs] of [['winners (20+ over SPY)', rows.filter(r => r.total >= 20)], ['  big winners (50+)', rows.filter(r => r.total >= 50)], ['losers (20+ under)', rows.filter(r => r.total <= -20)], ['everyone', rows]]) {
        if (!xs.length) continue
        const t = mean(xs.map(r => r.total)), rp = mean(xs.map(r => r.reports)), ig = mean(xs.map(r => r.industry)), ow = mean(xs.map(r => r.own))
        const perRep = mean(xs.map(r => (r.report_days ? r.reports / r.report_days : 0))), perOther = mean(xs.map(r => (r.industry + r.own) / (r.days - r.report_days)))
        console.log(`  ${label.padEnd(26)} ${String(xs.length).padStart(5)}  ${f(t).padStart(6)}   ${f(rp).padStart(6)}   ${f(ig).padStart(14)}   ${f(ow).padStart(10)}      ${(rp / t * 100).toFixed(0).padStart(4)}%     ${f(perRep)} / ${f(perOther)}`)
    }
    const win = rows.filter(r => r.total >= 20)
    console.log(`  winners: industry carried more than their own between-report move for ${win.filter(r => r.industry > r.own).length} of ${win.length}; reports carried MORE than half the gain for ${win.filter(r => r.reports > r.total / 2).length}; reports were negative for ${win.filter(r => r.reports < 0).length}`)
    for (const sym of show) { const r = rows.find(x => x.symbol === sym); if (r) console.log(`  ${sym}: total ${f(r.total)} = reports ${f(r.reports)} (${r.report_days} days) + industry ${f(r.industry)} + own ${f(r.own)}`) }
}
process.exit(0)
