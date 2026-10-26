// THE EARLY REPORTERS → THE LATE ONE — test F (reportReaction.service peerSeason): do the season's early reporters in an
// industry (their surprise, how many beat, how they reacted) tell how a later one reports, and which way it reacts?
// Bins cut before the split, the held-out year scored (Roy, 2026-10-26).
//
//   node scripts/lab-peer-season.mjs [--window=45] [--min=2]
//
// Offline: data/lab/screener-3y.json + its earnings history; industries from the latest screener stats.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const args = process.argv.slice(2)
const opt = (k, d) => Number(args.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d)
const { peerSeason, PEER_FEATURES } = await import('../services/reportReaction.service.js')
const { binByFeature, fitAndScore } = await import('../services/moverDiff.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { COLLECTION: STATS } = await import('../services/dailyScreener.service.js')
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')

const FROM = '2023-10-09', SPLIT = '2025-10-23'
const db = await getDb()
const last = await db.collection(STATS).find({}, { projection: { day: 1 } }).sort({ day: -1 }).limit(1).next()
const industryOf = new Map((await db.collection(STATS).find({ day: last.day }, { projection: { _id: 0, symbol: 1, industry: 1 } }).toArray()).filter(r => r.industry).map(r => [r.symbol, r.industry]))
const data = await loadLabData({ name: 'screener', years: 3, extras: ['history'] })
await closeDb()
const rows = peerSeason(data, industryOf, { from: FROM, windowDays: opt('window', 45), min: opt('min', 2) })
const s = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x}`)
const r2 = (x) => Math.round(x * 100) / 100
function stats(xs) {
    if (!xs.length) return 'none'
    const by = new Map()
    for (const x of xs) { if (!by.has(x.week)) by.set(x.week, []); by.get(x.week).push(x.net) }
    const per = [...by.values()].map(v => v.reduce((a, b) => a + b, 0) / v.length)
    const m = per.reduce((a, b) => a + b, 0) / per.length
    const sd = per.length > 1 ? Math.sqrt(per.reduce((a, b) => a + (b - m) ** 2, 0) / (per.length - 1)) : 0
    const se = sd / Math.sqrt(per.length)
    return `${String(xs.length).padStart(5)} · beat ${(xs.filter(x => x.beat).length / xs.length * 100).toFixed(1)}% · reacted up ${(xs.filter(x => x.up).length / xs.length * 100).toFixed(1)}% · reaction per day ${s(r2(m))}% [${s(r2(m - 1.96 * se))} … ${s(r2(m + 1.96 * se))}]`
}
console.log(`${rows.length} reports with ${opt('min', 2)}+ early reporters in their industry (${opt('window', 45)} days) · held out from ${SPLIT}`)
console.log(`  all   before ${stats(rows.filter(r => r.week < SPLIT))}`)
console.log(`        held   ${stats(rows.filter(r => r.week >= SPLIT))}\n`)

// Terciles of each early fact, cut before the split — the target's beat rate and reaction, before / held out.
for (const k of PEER_FEATURES) {
    const i = PEER_FEATURES.indexOf(k)
    const v = rows.filter(r => r.week < SPLIT).map(r => r.x[i]).sort((a, b) => a - b)
    const cuts = [v[Math.floor(v.length / 3)], v[Math.floor(2 * v.length / 3)]]
    const band = (x) => (x <= cuts[0] ? 0 : x <= cuts[1] ? 1 : 2)
    console.log(`── ${k} (cuts ${cuts.map(c => r2(c)).join(', ')})`)
    for (const [b, label] of [[0, 'low'], [1, 'mid'], [2, 'high']]) {
        const xs = rows.filter(r => band(r.x[i]) === b)
        console.log(`  ${label.padEnd(4)} before ${stats(xs.filter(r => r.week < SPLIT))}`)
        console.log(`       held   ${stats(xs.filter(r => r.week >= SPLIT))}`)
    }
}
// The two outcomes, the four facts together: the reaction (moverDiff fitAndScore as is), and the BEAT (up := beat).
for (const [label, list] of [['the reaction', rows], ['the beat', rows.map(r => ({ ...r, up: r.beat }))]]) {
    const m = fitAndScore(list, SPLIT, { features: PEER_FEATURES })
    console.log(`\n── ${label}: the four together, fitted on ${m.train}, held out ${m.held.n} — AUC ${m.held.auc} · weights ${Object.entries(m.weights).map(([k, w]) => `${k} ${w}`).join(' · ')}`)
    console.log(`  deciles (least → most): ${m.held.deciles.map(d => `${d.up}%`).join(' ')}`)
}
const b = binByFeature(rows.map(r => ({ ...r, up: r.beat })), SPLIT, PEER_FEATURES)
console.log(`\nbeat-rate spread top−bottom quintile, before / held out: ${Object.entries(b).map(([k, v]) => `${k} ${s(v.spread_before)} / ${s(v.spread_held)}`).join(' · ')}`)
process.exit(0)
