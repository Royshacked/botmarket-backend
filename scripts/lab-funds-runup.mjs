// THE FUNDS ON THE RUN-UP — test H (services/fundFlow.service.js factsKnown): the run-up rule's names, by the 13F facts
// public on the entry day — the run-up as it is (open k−5 → close k−1), the STAY through the report to the close before
// the next one, and the whole. Does what the funds did say which names to keep through the report (Roy, 2026-10-26:
// "as a rule for staying for the report — until following earnings")? Declared in screener-lab.md §23.
//
//   node scripts/lab-funds-runup.mjs [--dump=file.json]   (--dump writes every trade, for a closer look)
//
// fund_holdings from the `test` db; bars and reports offline (data/lab/screener-3y.json + history); caps from the latest stats.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { FUND_FEATURES, fundChanges, quintiles, capLookup, factsKnown } = await import('../services/fundFlow.service.js')
const { collectReports } = await import('../services/reportReaction.service.js')
const { trade, testable, blockRange, costFor } = await import('../services/screenerLab.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { COLLECTION: STATS } = await import('../services/dailyScreener.service.js')
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { config } = await import('../services/config.js')
const { MongoClient } = await import('mongodb')

const FROM = '2024-11-15', SPLIT = '2025-10-23', RUN = 5, GAP = [40, 110]
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
for (const r of collectReports(data, { from: FROM }).filter(x => x.rule)) {
    const s = data.names.get(r.symbol), k = s.ind.date.indexOf(r.week), i = k - RUN
    if (i < 1 || s.ind.date[i] < FROM || !testable(s.rows, i, s.ind)) continue
    const nextDay = [...s.reports.keys()].sort().find(d => d > r.week)
    const kn = nextDay ? s.ind.date.findIndex(d => d >= nextDay) : -1
    if (kn < 0 || kn - k < GAP[0] || kn - k > GAP[1]) continue
    const c = known(r.symbol, s.ind.date[i])
    if (!c) continue
    const run = trade({ rows: s.rows, i, ind: s.ind, hold: RUN, spyByDay: data.spyByDay })
    const whole = trade({ rows: s.rows, i, ind: s.ind, hold: kn - i, spyByDay: data.spyByDay })
    const a = data.spyByDay.get(s.ind.date[k - 1])?.close, b = data.spyByDay.get(s.ind.date[kn - 1])?.close
    if (!run || !whole || !(a > 0 && b > 0)) continue
    const stay = (s.rows[kn - 1].close / s.rows[k - 1].close - 1) * 100 - (b / a - 1) * 100
    rows.push({ symbol: r.symbol, day: run.day, run: run.net, stay, whole: whole.net, held: kn - i,
        q: Object.fromEntries(FUND_FEATURES.map(f => [f, qOf[f].get(c)])), cost: costFor(s.ind.adv20[i - 1] ?? 0) })
}

const days = data.spyDays.filter(d => d >= FROM)
const f = (x) => (x == null ? '   —  ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(7))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const line = (label, xs) => {
    if (!xs.length) return console.log(`  ${label.padEnd(22)} none`)
    const b = blockRange(xs.map(x => ({ day: x.day, net: x.stay })), days, 21)
    const half = (h) => { const ys = xs.filter(x => (x.day >= SPLIT) === h); return `${String(ys.length).padStart(3)} ${f(mean(ys.map(x => x.stay)))}` }
    console.log(`  ${label.padEnd(22)} ${String(xs.length).padStart(4)} · run-up ${f(mean(xs.map(x => x.run)))} · STAY ${f(mean(xs.map(x => x.stay)))} (up ${(xs.filter(x => x.stay > 0).length / xs.length * 100).toFixed(0)}%) · whole ${f(mean(xs.map(x => x.whole)))} · stay before ${half(false)} | held out ${half(true)} · stay blocks ${b ? `${f(b.ci95[0])} … ${f(b.ci95[1])}` : '—'}`)
}
console.log(`${rows.length} run-up trades (rule names, entries ${FROM} →) with 13F facts known at entry · median held to the next report ${[...rows.map(x => x.held)].sort((a, b) => a - b)[rows.length >> 1]} sessions`)
console.log('\n── every rule name'); line('all', rows)
for (const feat of FUND_FEATURES) {
    console.log(`\n── ${feat} quintile (within its quarter's whole cross-section)`)
    for (const k of [1, 2, 3, 4, 5]) line(`Q${k}`, rows.filter(x => x.q[feat] === k))
}
// The declared bar, on holders_chg Q5.
const top = rows.filter(x => x.q.holders_chg === 5), bot = rows.filter(x => x.q.holders_chg === 1)
const h = (xs, out) => mean(xs.filter(x => (x.day >= SPLIT) === out).map(x => x.stay))
const blk = blockRange(top.map(x => ({ day: x.day, net: x.stay })), days, 21)
const pass = h(top, false) > 0 && h(top, true) > 0 && h(top, false) > h(bot, false) && h(top, true) > h(bot, true) && blk?.ci95[0] > 0
console.log(`\nDECLARED (holders_chg Q5 stay): before ${f(h(top, false))} vs Q1 ${f(h(bot, false))} · held out ${f(h(top, true))} vs Q1 ${f(h(bot, true))} · blocks ${blk ? `${f(blk.ci95[0])} … ${f(blk.ci95[1])}` : '—'} → ${pass ? 'PASS' : 'FAIL'}`)
const dump = process.argv.slice(2).find(a => a.startsWith('--dump='))?.slice(7)
if (dump) fs.writeFileSync(dump, JSON.stringify(rows))
process.exit(0)
