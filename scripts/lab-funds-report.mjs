// THE FUNDS AT THE REPORT — test I (services/fundFlow.service.js factsKnown): every report's reaction (close k−1 → close
// k+1 vs SPY — reportReaction.collectReports) by the 13F facts public the day before it. Hold through the report or sell
// before (Roy, 2026-10-26: "can I use this data when deciding on the following earnings")? Declared in screener-lab.md §24.
//
//   node scripts/lab-funds-report.mjs
//
// fund_holdings from the `test` db; bars and reports offline (data/lab/screener-3y.json + history); caps from the latest stats.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { FUND_FEATURES, fundChanges, quintiles, capLookup, factsKnown } = await import('../services/fundFlow.service.js')
const { collectReports } = await import('../services/reportReaction.service.js')
const { fitAndScore } = await import('../services/moverDiff.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { COLLECTION: STATS } = await import('../services/dailyScreener.service.js')
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { config } = await import('../services/config.js')
const { MongoClient } = await import('mongodb')

const FROM = '2024-11-15', SPLIT = '2025-10-23'
const db = await getDb()
const last = await db.collection(STATS).find({}, { projection: { day: 1 } }).sort({ day: -1 }).limit(1).next()
const capOf = new Map((await db.collection(STATS).find({ day: last.day }, { projection: { _id: 0, symbol: 1, market_cap: 1 } }).toArray())
    .filter(r => r.market_cap > 0).map(r => [r.symbol, r.market_cap]))
await closeDb()
const mc = new MongoClient(config.mongoUri.trim().replace(/^['"]|['"]$/g, ''))
await mc.connect()
const holdings = await mc.db('test').collection('fund_holdings').find({}, { projection: { _id: 0, quarter: 1, symbol: 1, value: 1, holders: 1 } }).toArray()
await mc.close()
const data = await loadLabData({ name: 'screener', years: 3, extras: ['history'] })

const changes = fundChanges(holdings.filter(r => data.names.has(r.symbol)), capLookup(data, capOf))
const qOf = Object.fromEntries(FUND_FEATURES.map(k => [k, quintiles(changes, k)]))
const known = factsKnown(changes)
const rows = []
for (const r of collectReports(data, { from: FROM })) {
    const s = data.names.get(r.symbol), k = s.ind.date.indexOf(r.week)
    const c = known(r.symbol, s.ind.date[k - 1])
    if (!c) continue
    rows.push({ ...r, q: Object.fromEntries(FUND_FEATURES.map(f => [f, qOf[f].get(c)])),
        x: Float32Array.from(FUND_FEATURES, f => c.f[f]) })
}

const f = (x) => (x == null ? '   —  ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(7))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const cell = (xs) => (xs.length ? `${String(xs.length).padStart(4)} ${f(mean(xs.map(x => x.net)))} up ${(xs.filter(x => x.up).length / xs.length * 100).toFixed(1).padStart(4)}%` : 'none')
for (const [label, set] of [['every report', rows], ['the run-up rule\'s names', rows.filter(r => r.rule)]]) {
    console.log(`\n══ ${label}: ${set.length} reports · reaction close k−1 → close k+1 vs SPY · ${cell(set)}`)
    for (const feat of FUND_FEATURES) {
        console.log(`── ${feat}`)
        const sp = []
        for (const k of [1, 2, 3, 4, 5]) {
            const xs = set.filter(r => r.q[feat] === k)
            console.log(`  Q${k}  before ${cell(xs.filter(r => r.week < SPLIT))}   held out ${cell(xs.filter(r => r.week >= SPLIT))}`)
        }
        for (const out of [false, true]) {
            const h = set.filter(r => (r.week >= SPLIT) === out), top = h.filter(r => r.q[feat] === 5), bot = h.filter(r => r.q[feat] === 1)
            sp.push({ net: mean(top.map(x => x.net)) - mean(bot.map(x => x.net)), up: mean(top.map(x => +x.up)) - mean(bot.map(x => +x.up)) })
        }
        console.log(`  Q5−Q1 before ${f(sp[0].net)} (up ${f(sp[0].up * 100)}) · held out ${f(sp[1].net)} (up ${f(sp[1].up * 100)})`)
    }
    const fit = fitAndScore(set, SPLIT, { features: FUND_FEATURES })
    console.log(`  the three facts, fit before / scored held out: AUC ${fit.held.auc} on ${fit.held.n} (trained on ${fit.train}) · weights ${JSON.stringify(fit.weights)}`)
}
process.exit(0)
