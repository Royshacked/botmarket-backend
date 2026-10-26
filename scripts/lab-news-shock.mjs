// AFTER THE NEWS (services/newsShock.service.js) — a 5%+ day against SPY on twice the usual volume, bought at the next
// open: does it drift on or give it back? By direction, a report on the day, the size, and (the last year, where FMP's
// news reaches) the headlines' type (Roy, 2026-10-26: "run test A").
//
//   node scripts/lab-news-shock.mjs [--no-news] [--min=5] [--vol=2]
//
// Offline bars (data/lab/screener-3y.json + its earnings history); the news read once per shock day, in chunks, kept in
// data/lab/news-shock.news.json (resumable — a day already read is not read again).
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const args = process.argv.slice(2)
const opt = (k, d) => Number(args.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d)
const min = opt('min', 5), volMult = opt('vol', 2)
const { findShocks, shockTrades, sizeBand, classifyHeadlines, headlinesFor } = await import('../services/newsShock.service.js')
const { report, blockRange } = await import('../services/screenerLab.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { fetchStockNews } = await import('../providers/fmp.provider.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const FROM = '2023-10-09', SPLIT = '2025-10-23', NEWS_FROM = '2025-11-13'
const HOLDS = [1, 5, 10, 20]
const data = await loadLabData({ name: 'screener', years: 3, extras: ['history'] })
await closeDb()
const days = data.spyDays.filter(d => d >= FROM)
const shocks = findShocks(data, { min, volMult, days })
const next = new Map(data.spyDays.map((d, k) => [d, data.spyDays[k + 1]]))
const prev = new Map(data.spyDays.map((d, k) => [d, data.spyDays[k - 1]]))
console.log(`${shocks.length} shocks (${min}%+ vs SPY, ${volMult}x volume) over ${days.length} sessions, ${FROM} → ${days.at(-1)}; held out from ${SPLIT}`)
console.log(`  up ${shocks.filter(k => k.dir === 'up').length} (${shocks.filter(k => k.dir === 'up' && k.report).length} on a report) · down ${shocks.filter(k => k.dir === 'down').length} (${shocks.filter(k => k.dir === 'down' && k.report).length} on a report)\n`)

const s = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x}`)
const entryDays = days.map(d => next.get(d)).filter(Boolean)
function table(title, tagOf, list = shocks) {
    console.log(`── ${title} — net vs SPY per session (each session once) · blocks [95%] · up-share · before ${SPLIT} / held out`)
    const runs = HOLDS.map(h => ({ h, r: report(shockTrades(data, list, h, tagOf), entryDays, { hold: h, splitAt: SPLIT }) }))
    const tags = [...new Set(runs.flatMap(({ r }) => Object.keys(r.by_tag ?? {})))].sort()
    for (const tag of tags) {
        const n = runs[0].r.by_tag?.[tag]?.n ?? 0
        console.log(`  ${tag}  (${n})`)
        for (const { h, r } of runs) {
            const v = r.by_tag?.[tag]
            if (!v?.n) continue
            console.log(`     held ${String(h).padStart(2)}: ${s(v.net_session_mean).padStart(6)} [${v.ci95?.map(s).join(' … ') ?? '—'}]  up ${v.up_rate}%   ${s(v.first.net_session_mean)} / ${s(v.second.net_session_mean)}`)
        }
    }
    console.log('')
}
const dirRep = (k) => `${k.dir.padEnd(4)} · ${k.report ? 'earnings ' : 'no report'}`
table('by direction and report', dirRep)
table('by size', (k) => `${dirRep(k)} · ${sizeBand(k.size)}`)
// The block range the per-session one leaves out (neighbouring 20-session windows overlap): direction × report, held 20.
const t20 = shockTrades(data, shocks, 20, dirRep)
const r20 = report(t20, entryDays, { hold: 20, splitAt: SPLIT })
console.log('── held 20, all shocks: blocks', JSON.stringify(r20.all.blocks), ' baseline: run lab.mjs for every name\n')
for (const tag of [...new Set(t20.map(t => t.tag))].sort()) {
    const xs = t20.filter(t => t.tag === tag)
    console.log(`  ${tag}: blocks of 20 →`, JSON.stringify(blockRange(xs, entryDays, 20)), ` next-open gap ${s(Math.round(xs.reduce((a, t) => a + t.gap, 0) / xs.length * 100) / 100)}%`)
}
console.log('')

if (args.includes('--no-news')) process.exit(0)

// ── The headlines, the last year: non-earnings shocks only (an earnings day's type is the report).
const FILE = 'data/lab/news-shock.news.json'
const kept = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {}
const recent = shocks.filter(k => !k.report && k.day >= NEWS_FROM && next.get(k.day))
const byDay = new Map()
for (const k of recent) { if (!byDay.has(k.day)) byDay.set(k.day, []); byDay.get(k.day).push(k.symbol) }
let calls = 0
for (const [day, syms] of [...byDay].sort()) {
    if (kept[day]) continue
    const rows = []
    for (let c = 0; c < syms.length; c += 8) {
        const chunk = syms.slice(c, c + 8)
        for (let a = 1; ; a++) {
            try {
                const got = await fetchStockNews({ symbols: chunk, from: prev.get(day), to: next.get(day), limit: 250 })
                if (got.length >= 250) console.log(`  ${day}: a chunk hit the 250 cap — some headlines cut`)
                rows.push(...got.map(n => ({ symbol: n.symbol, title: n.title, publishedDate: n.publishedDate })))
                break
            } catch (err) {
                if (a >= 3) { console.log(`  ${day}: news failed — ${err.message}`); break }
                await new Promise(r => setTimeout(r, 15_000 * a))
            }
        }
        calls++
        await new Promise(r => setTimeout(r, 1100))
    }
    kept[day] = rows
    fs.writeFileSync(FILE, JSON.stringify(kept))
}
console.log(`news: ${calls} reads this run, ${byDay.size} shock days\n`)
const typeOf = new Map()
for (const k of recent) {
    const h = headlinesFor(kept[k.day] ?? [], prev.get(k.day), next.get(k.day))
    typeOf.set(`${k.symbol}|${k.day}`, classifyHeadlines(h.get(k.symbol)))
}
const counts = {}
for (const k of recent) { const t = `${k.dir} · ${typeOf.get(`${k.symbol}|${k.day}`)}`; counts[t] = (counts[t] ?? 0) + 1 }
console.log('non-earnings shocks by headline type, the last year:', JSON.stringify(counts), '\n')
// One year: the halves here are the year's halves (splitAt null), not the held-out split.
function newsTable() {
    console.log(`── no report, by headline type (${NEWS_FROM} →) — net vs SPY per session [95%] · up-share · year's halves`)
    const recentEntry = entryDays.filter(d => d > NEWS_FROM)
    const tagOf = (k) => `${k.dir.padEnd(4)} · ${typeOf.get(`${k.symbol}|${k.day}`)}`
    const runs = HOLDS.map(h => ({ h, r: report(shockTrades(data, recent, h, tagOf), recentEntry, { hold: h }) }))
    for (const tag of [...new Set(runs.flatMap(({ r }) => Object.keys(r.by_tag ?? {})))].sort()) {
        console.log(`  ${tag}  (${runs[0].r.by_tag?.[tag]?.n ?? 0})`)
        for (const { h, r } of runs) {
            const v = r.by_tag?.[tag]
            if (!v?.n) continue
            console.log(`     held ${String(h).padStart(2)}: ${s(v.net_session_mean).padStart(6)} [${v.ci95?.map(s).join(' … ') ?? '—'}]  up ${v.up_rate}%   ${s(v.first.net_session_mean)} / ${s(v.second.net_session_mean)}`)
        }
    }
}
newsTable()
process.exit(0)
