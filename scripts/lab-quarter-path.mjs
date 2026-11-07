// WHAT HAPPENED INSIDE A WINNING QUARTER (declared in screener-lab.md §40, before the run). Roy, 2026-11-07: "so what
// happened to the stocks during the quarter?" §36's rows, day by day: the quarter in parts (run-up, report, shock days,
// the quiet rest), its shape, and what the shock days were (the 8-Ks filed; the headlines for the last year).
//
//   node --max-old-space-size=6000 scripts/lab-quarter-path.mjs           (the read; writes the last year's shock days)
//   node scripts/lab-quarter-path.mjs --news                              (small process: their headlines, resumable)
//   … then the read again, with the headlines.
//
// Offline but for --news: data/lab caches + data/lab/sec-8k.jsonl (lab-8k-items-fetch.mjs).
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const SHOCKS = 'data/lab/quarter-path-shocks.json', NEWS = 'data/lab/quarter-path.news.json', NEWS_FROM = '2025-11-13'

if (process.argv.includes('--news')) {
    const { fetchStockNews } = await import('../providers/fmp.provider.js')
    const list = JSON.parse(fs.readFileSync(SHOCKS, 'utf8'))
    const kept = fs.existsSync(NEWS) ? JSON.parse(fs.readFileSync(NEWS, 'utf8')) : {}
    let calls = 0
    for (const k of list) {
        const key = `${k.symbol} ${k.day}`
        if (kept[key]) continue
        try {
            const got = await fetchStockNews({ symbols: [k.symbol], from: k.prev, to: k.day, limit: 100 })
            kept[key] = got.filter(n => String(n.symbol).toUpperCase() === k.symbol).map(n => [n.publishedDate, n.title])
        } catch (err) { console.log(`  ${key}: ${err.message}`); continue }
        if (++calls % 25 === 0) { fs.writeFileSync(NEWS, JSON.stringify(kept)); console.log(`  ${calls} read`) }
        await new Promise(r => setTimeout(r, 400))
    }
    fs.writeFileSync(NEWS, JSON.stringify(kept))
    console.log(`news: ${calls} read · ${Object.keys(kept).length} kept of ${list.length}`)
    process.exit(0)
}

const { classifyHeadlines } = await import('../services/newsShock.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const EDGE = 5, SPLIT = '2024-01-01', FIRST_Q = '2020-Q1', LAST_Q = '2026-Q3', SHOCK = 5, VOL = 2, RUN = 5
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
await closeDb()
const eightK = new Map(fs.existsSync('data/lab/sec-8k.jsonl') ? fs.readFileSync('data/lab/sec-8k.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.f).map(r => [r.symbol, r.f]) : [])
const news = fs.existsSync(NEWS) ? JSON.parse(fs.readFileSync(NEWS, 'utf8')) : null

const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)
const qOf = (d) => `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`
const quarters = []
for (const d of data.spyDays) {
    const q = qOf(d), cur = quarters.at(-1)
    if (cur?.q === q) cur.last = d
    else quarters.push({ q, first: d, last: d, base: cur?.last ?? null })
}
const Q = quarters.filter(x => x.base && x.q >= FIRST_Q && x.q <= LAST_Q)

/** An 8-K's items → the one kind it is read as, the most telling first. */
const KIND = [['2.02', 'results (2.02)'], ['2.01', 'deal closed (2.01)'], ['1.01', 'agreement (1.01)'], ['5.02', 'people (5.02)'],
    ['1.02', 'bad news (1.02/2.05/2.06/4.02)'], ['2.05', 'bad news (1.02/2.05/2.06/4.02)'], ['2.06', 'bad news (1.02/2.05/2.06/4.02)'], ['4.02', 'bad news (1.02/2.05/2.06/4.02)'],
    ['7.01', 'other news (7.01/8.01)'], ['8.01', 'other news (7.01/8.01)']]
const kindOf = (items) => { const xs = items.flatMap(s => s.split(',').map(z => z.trim())); return KIND.find(([c]) => xs.includes(c))?.[1] ?? (xs.length ? 'other items' : 'no 8-K') }

const rows = [], shockDays = []
for (const [symbol, s] of data.names) {
    const at = new Map(s.ind.date.map((d, n) => [d, n]))
    const dates = [...s.reports.keys()].sort(), filings = eightK.get(symbol)
    for (const x of Q) {
        const j = at.get(x.base)
        if (j == null || j < 60 || !member(symbol, x.first)) continue
        let e = at.get(x.last)
        if (e == null) {
            const lastDay = s.ind.date.at(-1)
            if (!(lastDay > x.base && lastDay < x.last)) continue
            e = s.ind.date.length - 1
        }
        // The report in the quarter: its sessions k and k+1 (the reaction), and the RUN sessions before.
        const repDay = dates.find(d => d > x.base && d <= s.ind.date[e])
        const k = repDay ? s.ind.date.findIndex(d => d >= repDay) : -1
        const parts = { runup: 0, report: 0, shock: 0, quiet: 0 }, ex = [], shocks = []
        let ok = true
        for (let d = j + 1; d <= e; d++) {
            const sp = data.spyByDay.get(s.ind.date[d]), sp0 = data.spyByDay.get(s.ind.date[d - 1])
            const r = pct(s.rows[d].close, s.rows[d - 1].close), m = pct(sp?.close, sp0?.close)
            if (r == null || m == null) { ok = false; break }
            const v = r - m
            ex.push(v)
            const avgVol = s.rows.slice(Math.max(0, d - 20), d).reduce((a, b) => a + (b.volume || 0), 0) / Math.min(20, d)
            const inReport = k >= 0 && (d === k || d === k + 1), inRun = k >= 0 && d >= k - RUN && d < k
            if (inReport) parts.report += v
            else if (Math.abs(v) >= SHOCK && avgVol > 0 && s.rows[d].volume >= VOL * avgVol) {
                parts.shock += v
                const day = s.ind.date[d], lo = s.ind.date[d - 1], hi = s.ind.date[Math.min(d + 2, s.ind.date.length - 1)]
                const items = (filings ?? []).filter(([f]) => f >= lo && f <= hi).map(([, it]) => it)
                shocks.push({ day, prev: s.ind.date[d - 1], v, kind: filings ? kindOf(items) : 'no SEC list', inRun })
            } else if (inRun) parts.runup += v
            else parts.quiet += v
        }
        if (!ok || !ex.length) continue
        const total = ex.reduce((a, b) => a + b, 0)
        let cum = 0, low = 0
        for (const v of ex) { cum += v; low = Math.min(low, cum) }
        const third = Math.ceil(ex.length / 3), sum = (xs) => xs.reduce((a, b) => a + b, 0)
        const sorted = [...ex].sort((a, b) => b - a)
        const net = pct(s.rows[e].close, s.rows[j].close) - pct(data.spyByDay.get(s.ind.date[e])?.close, data.spyByDay.get(x.base)?.close)
        const row = { symbol, q: x.q, day: x.first, net, total, parts, shocks, hadReport: k >= 0,
            best1: sorted[0], best3: sum(sorted.slice(0, 3)), worst1: sorted.at(-1), months: [sum(ex.slice(0, third)), sum(ex.slice(third, 2 * third)), sum(ex.slice(2 * third))],
            half: sum(ex.slice(0, Math.floor(ex.length / 2))), low, group: net >= EDGE ? 'win' : net <= -EDGE ? 'lose' : 'mid' }
        rows.push(row)
        if (row.group !== 'mid') for (const k2 of shocks) if (k2.day >= NEWS_FROM) shockDays.push({ symbol, day: k2.day, prev: k2.prev, group: row.group })
    }
}
fs.writeFileSync(SHOCKS, JSON.stringify(shockDays))

const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
const share = (ts, p) => (ts.length ? `${(ts.filter(p).length / ts.length * 100).toFixed(0)}%` : '—').padStart(4)
const G = (ts, g) => ts.filter(r => r.group === g)
const PARTS = ['runup', 'report', 'shock', 'quiet']

console.log(`${rows.length} name-quarters · the parts are each session's return less SPY's, summed (the sum ≈ the quarter's net: median gap ${f2(median(rows.map(r => r.total - r.net)))})`)
console.log(`8-K lists for ${eightK.size} of ${Object.keys(u.spans).length} names`)

console.log('\n── THE QUARTER IN PARTS: mean (median) per group')
for (const [label, ts] of [['all years', rows], ['2020–2023', rows.filter(r => r.day < SPLIT)], ['2024 →', rows.filter(r => r.day >= SPLIT)]]) {
    console.log(`  ${label}`)
    for (const g of ['win', 'mid', 'lose']) {
        const x = G(ts, g)
        console.log(`    ${g.padEnd(4)} ${String(x.length).padStart(5)} · total ${f2(mean(x.map(r => r.total)))} = ${PARTS.map(p => `${p} ${f2(mean(x.map(r => r.parts[p])))} (${f2(median(x.map(r => r.parts[p])), 0)})`).join(' + ')}`)
    }
}

console.log('\n── WHICH PART MADE THE QUARTER (the biggest part of each winner / loser)')
for (const g of ['win', 'lose']) {
    const x = G(rows, g), sign = g === 'win' ? 1 : -1
    const top = (r) => PARTS.reduce((a, p) => (sign * r.parts[p] > sign * r.parts[a] ? p : a), 'quiet')
    console.log(`  ${g.padEnd(4)} ${PARTS.map(p => `${p} ${share(x, r => top(r) === p)}`).join(' · ')} · had a shock day ${share(x, r => r.shocks.length > 0)} · an up shock ${share(x, r => r.shocks.some(z => z.v > 0))} · a down shock ${share(x, r => r.shocks.some(z => z.v < 0))}`)
}
console.log('  (mid)', ['mid'].map(g => { const x = G(rows, g); return `had a shock day ${share(x, r => r.shocks.length > 0)} · up ${share(x, r => r.shocks.some(z => z.v > 0))} · down ${share(x, r => r.shocks.some(z => z.v < 0))}` })[0])

console.log('\n── THE SHAPE')
for (const g of ['win', 'mid', 'lose']) {
    const x = G(rows, g)
    console.log(`  ${g.padEnd(4)} best day ${f2(median(x.map(r => r.best1)))} · best 3 days ${f2(median(x.map(r => r.best3)))} · worst day ${f2(median(x.map(r => r.worst1)))} · months ${[0, 1, 2].map(m => f2(median(x.map(r => r.months[m])), 0)).join(' / ')} · behind SPY at halfway ${share(x, r => r.half < 0)} · worst dip ${f2(median(x.map(r => r.low)))}`)
}
const W = G(rows, 'win')
console.log(`  winners WITHOUT their best 3 days: median ${f2(median(W.map(r => r.total - r.best3)))} · still beat SPY by 5%+ ${share(W, r => r.total - r.best3 >= 5)} · without the best day ${share(W, r => r.total - r.best1 >= 5)}`)

console.log('\n── THE SHOCK DAYS (away from the report): what the company filed, from the day before to two days after')
const allShocks = (g, dir) => G(rows, g).flatMap(r => r.shocks.filter(z => (dir > 0 ? z.v > 0 : z.v < 0)))
for (const [g, dir, label] of [['win', 1, 'winners, up shocks'], ['lose', -1, 'losers, down shocks'], ['win', -1, 'winners, down shocks'], ['lose', 1, 'losers, up shocks']]) {
    const z = allShocks(g, dir), by = new Map()
    for (const s of z) by.set(s.kind, (by.get(s.kind) ?? 0) + 1)
    console.log(`  ${label.padEnd(22)} ${String(z.length).padStart(5)} · mean ${f2(mean(z.map(s => s.v)))} · in the run-up ${share(z, s => s.inRun)} · ${[...by].sort((a, b) => b[1] - a[1]).map(([kd, n]) => `${kd} ${(n / z.length * 100).toFixed(0)}%`).join(' · ')}`)
}

if (news) {
    console.log(`\n── THE HEADLINES ON THE SHOCK DAYS, ${NEWS_FROM} → (test A's keyword types; the news of the day before 16:00 to the day's end)`)
    for (const [g, dir, label] of [['win', 1, 'winners, up shocks'], ['lose', -1, 'losers, down shocks']]) {
        const z = G(rows, g).flatMap(r => r.shocks.filter(s => (dir > 0 ? s.v > 0 : s.v < 0) && s.day >= NEWS_FROM).map(s => ({ ...s, symbol: r.symbol })))
        const by = new Map(), seen = []
        for (const s of z) {
            const titles = (news[`${s.symbol} ${s.day}`] ?? []).filter(([at]) => at >= `${s.prev} 16:00` && at <= `${s.day} 23:59`).map(([, t]) => t)
            const t = classifyHeadlines(titles)
            by.set(t, (by.get(t) ?? 0) + 1)
            if (seen.length < 12 && titles.length) seen.push(`${s.symbol} ${s.day} ${f2(s.v, 0)} [${t}] ${titles[titles.length - 1].slice(0, 90)}`)
        }
        console.log(`  ${label} (${z.length}): ${[...by].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${(n / z.length * 100).toFixed(0)}%`).join(' · ')}`)
        for (const l of seen) console.log(`     ${l}`)
    }
}
process.exit(0)
