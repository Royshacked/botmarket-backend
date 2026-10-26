// THE FUNDS (13F) — test G (services/fundFlow.service.js): does what the funds did last quarter — ownership up or down,
// more or fewer filers, how crowded — say where a company goes over the next quarter? Bought at the first open after
// the filing deadline (quarter end + 46 days; --lag=20 enters that many sessions later), held 63 sessions, net of SPY
// and the cost; quintiles within each quarter (Roy, 2026-10-26: "start with EDGAR"). Declared in screener-lab.md §22.
//
//   node scripts/lab-funds.mjs [--lag=0] [--hold=63]
//
// fund_holdings from the `test` db (only there); bars offline (data/lab/screener-3y.json); caps from the latest screener stats.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const args = process.argv.slice(2)
const opt = (k, d) => Number(args.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d)
const lag = opt('lag', 0), HOLD = opt('hold', 63), MIN_HOLD = 40
const { FUND_FEATURES, fundChanges, publicDay, quintiles, capLookup } = await import('../services/fundFlow.service.js')
const { trade, testable } = await import('../services/screenerLab.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { COLLECTION: STATS } = await import('../services/dailyScreener.service.js')
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { config } = await import('../services/config.js')
const { MongoClient } = await import('mongodb')

const SPLIT = '2025-10-23'
const EXPECT = { own_chg: 1, holders_chg: 1, own_level: -1 }   // the literature's sign for top-minus-bottom
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

const lastAtOrBefore = (dates, day) => { let lo = 0, hi = dates.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= day) { k = m; lo = m + 1 } else hi = m - 1 } return k }
const capOn = capLookup(data, capOf)
const inLab = holdings.filter(r => data.names.has(r.symbol))
const changes = fundChanges(inLab, capOn)
// A CONTROL, not declared: the price move over the same quarter (quarter end → quarter end), vs SPY. Rising filers follow
// a rising price, so breadth may be momentum by another name — the control says whether it is.
const closeAt = (s, day) => { const j = lastAtOrBefore(s.ind.date, day); return j >= 0 ? s.rows[j].close : null }
for (const c of changes) {
    const s = data.names.get(c.symbol), a = closeAt(s, c.prev), b = closeAt(s, c.quarter)
    const sa = data.spyByDay.get(data.spyDays[lastAtOrBefore(data.spyDays, c.prev)])?.close, sb = data.spyByDay.get(data.spyDays[lastAtOrBefore(data.spyDays, c.quarter)])?.close
    c.f.mom = a > 0 && b > 0 && sa > 0 && sb > 0 ? ((b / a) / (sb / sa) - 1) * 100 : null
}
const CONTROLS = ['mom']
EXPECT.mom = 1

// The trade per change: the first session on/after the public day (+ lag sessions), 63 held (or to the latest close).
const trades = new Map()
for (const c of changes) {
    const s = data.names.get(c.symbol), pd = publicDay(c.quarter)
    let i = s.ind.date.findIndex(d => d >= pd)
    if (i < 0 || Date.parse(s.ind.date[i]) - Date.parse(pd) > 7 * 86_400_000) continue
    i += lag
    if (i >= s.rows.length || !testable(s.rows, i, s.ind)) continue
    const hold = Math.min(HOLD, s.rows.length - i)
    if (hold < MIN_HOLD) continue
    const t = trade({ rows: s.rows, i, ind: s.ind, hold, spyByDay: data.spyByDay })
    if (t) trades.set(c, { ...t, hold })
}
const scored = changes.filter(c => trades.has(c))
const periods = [...new Set(scored.map(c => c.quarter))].sort()
console.log(`fund_holdings ${holdings.length} rows · in the lab ${inLab.length} · changes ${changes.length} · traded ${scored.length} · lag ${lag} sessions, hold ${HOLD}`)
for (const q of periods) {
    const xs = scored.filter(c => c.quarter === q), t0 = trades.get(xs[0])
    console.log(`  ${q} → enter ${t0.day} · ${String(xs.length).padStart(4)} names · held ${t0.hold} · ${t0.day >= SPLIT ? 'HELD OUT' : 'before'}`)
}

const f = (x) => (x == null ? '   —  ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(7))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
{
    const xs = changes.filter(c => c.f.mom != null), corr = (k) => { const a = xs.map(c => c.f[k]), b = xs.map(c => c.f.mom), ma = mean(a), mb = mean(b)
        return a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0) * b.reduce((s, v) => s + (v - mb) ** 2, 0)) }
    console.log(`
correlation with the quarter's price move (the control): ${FUND_FEATURES.map(k => `${k} ${corr(k).toFixed(2)}`).join(' · ')}`)
}
for (const feat of [...FUND_FEATURES, ...CONTROLS]) {
    const qOf = quintiles(scored, feat)
    console.log(`\n── ${feat} (expected: top ${EXPECT[feat] > 0 ? 'beats' : 'trails'} bottom) · net vs SPY over the hold, mean per name`)
    console.log(`  period       ${[1, 2, 3, 4, 5].map(k => `   Q${k}  `).join(' ')}   Q5−Q1   cuts Q1|Q5`)
    const spread = []
    for (const q of periods) {
        const xs = scored.filter(c => c.quarter === q)
        const m = [1, 2, 3, 4, 5].map(k => mean(xs.filter(c => qOf.get(c) === k).map(c => trades.get(c).net)))
        const vals = xs.map(c => c.f[feat]).sort((a, b) => a - b)
        const cut = (p) => vals[Math.floor(p * vals.length)].toFixed(1)
        spread.push({ q, s: m[4] - m[0], top: EXPECT[feat] > 0 ? m[4] : m[0], out: trades.get(xs[0]).day >= SPLIT })
        console.log(`  ${q}  ${m.map(f).join(' ')}  ${f(m[4] - m[0])}   ${cut(0.2)}|${cut(0.8)}`)
    }
    const right = spread.filter(x => Math.sign(x.s) === EXPECT[feat]).length
    for (const [label, xs] of [['before', spread.filter(x => !x.out)], ['held out', spread.filter(x => x.out)]])
        console.log(`  ${label.padEnd(9)} Q5−Q1 ${f(mean(xs.map(x => x.s)))} · long side (Q${EXPECT[feat] > 0 ? 5 : 1}) ${f(mean(xs.map(x => x.top)))} · expected sign in ${xs.filter(x => Math.sign(x.s) === EXPECT[feat]).length}/${xs.length}`)
    const b = spread.filter(x => !x.out), h = spread.filter(x => x.out)
    const pass = Math.sign(mean(b.map(x => x.s))) === EXPECT[feat] && Math.sign(mean(h.map(x => x.s))) === EXPECT[feat] && right >= 6
    const longOnly = pass && mean(b.map(x => x.top)) > 0 && mean(h.map(x => x.top)) > 0
    console.log(`  → ${pass ? 'PASS' : 'FAIL'} (expected sign in ${right}/${spread.length})${pass ? ` · long-only ${longOnly ? 'YES' : 'no'}` : ''}`)
}
process.exit(0)
