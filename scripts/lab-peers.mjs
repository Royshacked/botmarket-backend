// THE SECOND ORDER — test B (services/newsShock.service.js peerRows): when a name shocks (5%+ vs SPY on 2x volume), do
// its INDUSTRY peers move with it that day, and do they keep going after? Bought at the next open, held 1/5/10/20, net
// of SPY and the cost; by the shock's direction, a report behind it, the peer's own reaction that day, a bigger shocker
// (leader → laggard) and the peer's own report coming (Roy, 2026-10-26: "test b").
//
//   node scripts/lab-peers.mjs [--min=5] [--vol=2]
//
// Offline bars (data/lab/screener-3y.json + its earnings history); industries and caps from the latest screener stats.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const args = process.argv.slice(2)
const opt = (k, d) => Number(args.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d)
const min = opt('min', 5), volMult = opt('vol', 2)
const { findShocks, shockTrades, industryDays, peerRows } = await import('../services/newsShock.service.js')
const { report, blockRange } = await import('../services/screenerLab.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { COLLECTION: STATS } = await import('../services/dailyScreener.service.js')
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')

const FROM = '2023-10-09', SPLIT = '2025-10-23', HOLDS = [1, 5, 10, 20]
const db = await getDb()
const last = await db.collection(STATS).find({}, { projection: { day: 1 } }).sort({ day: -1 }).limit(1).next()
const stats = await db.collection(STATS).find({ day: last.day }, { projection: { _id: 0, symbol: 1, industry: 1, market_cap: 1 } }).toArray()
const industryOf = new Map(stats.filter(r => r.industry).map(r => [r.symbol, r.industry]))
const capOf = new Map(stats.filter(r => r.market_cap > 0).map(r => [r.symbol, r.market_cap]))
const data = await loadLabData({ name: 'screener', years: 3, extras: ['history'] })
await closeDb()

const days = data.spyDays.filter(d => d >= FROM)
const next = new Map(data.spyDays.map((d, k) => [d, data.spyDays[k + 1]]))
const entryDays = days.map(d => next.get(d)).filter(Boolean)
const shocks = findShocks(data, { min, volMult, days })
const idays = industryDays(shocks, industryOf)
const rows = peerRows(data, idays, { industryOf, capOf })
const sizes = {}
for (const ind of industryOf.values()) sizes[ind] = (sizes[ind] ?? 0) + 1
console.log(`${industryOf.size} names in ${Object.keys(sizes).length} industries (${Object.values(sizes).filter(n => n >= 4).length} with 4+); ${shocks.length} shocks → ${idays.length} one-way industry-days → ${rows.length} peer rows`)

const s = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x}`)
const r2 = (x) => Math.round(x * 100) / 100
// Day 0 — the peers' own move the session of the shock (no trade, no cost): each session once.
function day0(label, xs) {
    const by = new Map()
    for (const x of xs) { if (!by.has(x.day)) by.set(x.day, []); by.get(x.day).push(x.day0) }
    const per = [...by.values()].map(v => v.reduce((a, b) => a + b, 0) / v.length)
    const m = per.reduce((a, b) => a + b, 0) / per.length
    const sd = Math.sqrt(per.reduce((a, b) => a + (b - m) ** 2, 0) / (per.length - 1))
    const share = xs.filter(x => x.day0 > 0).length / xs.length
    console.log(`  ${label.padEnd(28)} ${String(xs.length).padStart(6)} peers  day 0 vs SPY ${s(r2(m))}% [${s(r2(m - 1.96 * sd / Math.sqrt(per.length)))} … ${s(r2(m + 1.96 * sd / Math.sqrt(per.length)))}]  up ${Math.round(share * 100)}%`)
}
console.log('\n── DAY 0: do the peers move with the shock the same session?')
for (const dir of ['up', 'down']) for (const rep of [true, false]) day0(`${dir} · ${rep ? 'earnings' : 'no report'}`, rows.filter(x => x.dir === dir && x.report === rep))
const share = (dir) => { const xs = rows.filter(x => x.dir === dir); return Object.fromEntries(['quiet', 'along', 'against'].map(k => [k, Math.round(xs.filter(x => x.reaction === k).length / xs.length * 100) + '%'])) }
console.log('  reactions — up:', JSON.stringify(share('up')), ' down:', JSON.stringify(share('down')))

function table(title, tagOf, list = rows) {
    console.log(`\n── ${title} — peer bought next open, net vs SPY per session (each session once) [95%] · up-share · before ${SPLIT} / held out`)
    const runs = HOLDS.map(h => ({ h, t: shockTrades(data, list, h, tagOf) })).map(({ h, t }) => ({ h, t, r: report(t, entryDays, { hold: h, splitAt: SPLIT }) }))
    for (const tag of [...new Set(runs.flatMap(({ r }) => Object.keys(r.by_tag ?? {})))].sort()) {
        console.log(`  ${tag}  (${runs[0].r.by_tag?.[tag]?.n ?? 0})`)
        for (const { h, t, r } of runs) {
            const v = r.by_tag?.[tag]
            if (!v?.n) continue
            const b = h >= 5 ? blockRange(t.filter(x => x.tag === tag), entryDays, h) : null
            console.log(`     held ${String(h).padStart(2)}: ${s(v.net_session_mean).padStart(6)} [${v.ci95?.map(s).join(' … ') ?? '—'}]${b ? `  blocks ${s(b.mean)} [${b.ci95.map(s).join(' … ')}]` : ''}  up ${v.up_rate}%   ${s(v.first.net_session_mean)} / ${s(v.second.net_session_mean)}`)
        }
    }
}
const dr = (x) => `${x.dir.padEnd(4)} · ${x.report ? 'earnings ' : 'no report'}`
table('AFTER: by the shock', dr)
table('AFTER: by the peer\'s own reaction that day', (x) => `${dr(x)} · ${x.reaction}`)
table('AFTER: a bigger name shocked (leader → laggard), quiet peers only', (x) => (x.reaction !== 'quiet' || x.leader == null ? null : `${dr(x)} · ${x.leader ? 'leader shocked' : 'smaller shocked'}`))
table('AFTER: earnings read-through — quiet peers whose own report is within 20 sessions', (x) => (x.report && x.reaction === 'quiet' ? `${x.dir.padEnd(4)} · peer reports ${x.reportsIn ? 'soon' : 'later'}` : null))
process.exit(0)
