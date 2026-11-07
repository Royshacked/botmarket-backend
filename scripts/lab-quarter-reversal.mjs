// BOUGHT WEAK AT THE QUARTER'S START, HELD THE QUARTER — test R (declared in screener-lab.md §37, before the run). §36's
// one lead as a trade: the S&P 500 members furthest under their 20-day average at the close before a calendar quarter,
// bought at its first open, sold at its last close, against SPY and against every member held the same way.
//
//   node --max-old-space-size=6000 scripts/lab-quarter-reversal.mjs
//
// Offline: data/lab caches.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { holdBook, bookBlocks } = await import('../services/holdToNext.service.js')
const { testable, costFor } = await import('../services/screenerLab.service.js')
const { featuresAt } = await import('../services/moverDiff.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const SPLIT = '2024-01-01', FIRST_Q = '2020-Q1', LAST_Q = '2026-Q3'
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
await closeDb()

const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)
const qOf = (d) => `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`
const quarters = []
for (const d of data.spyDays) {
    const q = qOf(d), cur = quarters.at(-1)
    if (cur?.q === q) cur.last = d
    else quarters.push({ q, first: d, last: d, base: cur?.last ?? null })
}
const Q = quarters.filter(x => x.base && x.q >= FIRST_Q && x.q <= LAST_Q)

// Every member's quarter as a trade, with its start-of-quarter facts.
const trades = []
for (const [symbol, s] of data.names) {
    const at = new Map(s.ind.date.map((d, n) => [d, n]))
    for (const x of Q) {
        const j = at.get(x.base), i = at.get(x.first)
        if (j == null || i == null || i !== j + 1 || j < 60 || !member(symbol, x.first)) continue
        if (!(s.rows[i]?.open > 0) || !testable(s.rows, i, s.ind)) continue
        let e = at.get(x.last)
        if (e == null) {
            if (!(s.ind.date.at(-1) < x.last)) continue
            e = s.ind.date.length - 1
        }
        const s0 = data.spyByDay.get(x.first), s1 = data.spyByDay.get(s.ind.date[e])
        const ret = pct(s.rows[e].close, s.rows[i].open), spy = pct(s1?.close, s0?.open)
        if (ret == null || spy == null) continue
        const f = featuresAt(s, data, j, i, i), cost = costFor(s.ind.adv20[j] ?? 0)
        trades.push({ symbol, q: x.q, day: x.first, i, x: e, cost, ret, spy, net: ret - spy - cost, vs_sma20: f.vs_sma20, ret20: f.ret20, ret5: f.ret5 })
    }
}
/** Each quarter's fifth `b` (0 = lowest) by `key`, cut within that quarter. */
function fifth(key, b) {
    const out = []
    for (const x of Q) {
        const ts = trades.filter(t => t.q === x.q && Number.isFinite(t[key])).sort((p, z) => p[key] - z[key])
        out.push(...ts.slice(Math.floor(b * ts.length / 5), Math.floor((b + 1) * ts.length / 5)))
    }
    return out
}

const days = data.spyDays.filter(d => d >= Q[0].first && d <= Q.at(-1).last)
const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
function read(ts) {
    const b = holdBook(data, ts)
    return { n: ts.length, per: mean(ts.map(t => t.net)), beat: ts.filter(t => t.net > 0).length / ts.length * 100,
        whole: bookBlocks(b, days), before: bookBlocks(b, days.filter(d => d < SPLIT)), after: bookBlocks(b, days.filter(d => d >= SPLIT)) }
}
const line = (label, r) => console.log(`  ${label.padEnd(30)} ${String(r.n).padStart(5)} · per quarter ${f2(r.per)} beat SPY ${r.beat.toFixed(0)}% · book/mo ${f2(r.whole?.mean)} t ${r.whole?.t?.toFixed(2) ?? '—'} · before ${f2(r.before?.mean)} after ${f2(r.after?.mean)}`)

const signal = fifth('vs_sma20', 0), S = read(signal), A = read(trades)
console.log(`${trades.length} member-quarters · ${Q.length} quarters ${Q[0].q} → ${Q.at(-1).q} · book per month, net of SPY and the cost`)
console.log('\n── THE PRIMARY')
line('bottom fifth by vs 20-day avg', S)
line('every member (control)', A)

console.log('\n── DESCRIPTIONS')
for (let b = 0; b < 5; b++) line(`vs 20-day avg, fifth ${b + 1}`, read(fifth('vs_sma20', b)))
line('bottom fifth by last month', read(fifth('ret20', 0)))
line('bottom fifth by last week', read(fifth('ret5', 0)))
const sorted = [...signal].sort((p, z) => z.net - p.net), cut = Math.max(1, Math.round(signal.length / 100))
line(`primary without its best 1% (${cut})`, read(sorted.slice(cut)))
console.log(`  the best: ${sorted.slice(0, 8).map(t => `${t.symbol} ${t.q} ${f2(t.net, 0)}`).join(' · ')}`)
console.log('  by quarter (primary − control, per trade):')
console.log('   ' + Q.map(x => { const a = mean(signal.filter(t => t.q === x.q).map(t => t.net)), c = mean(trades.filter(t => t.q === x.q).map(t => t.net)); return `${x.q} ${f2(a - c, 0)}` }).join(' · '))

const beatsSpy = S.before?.mean > 0 && S.after?.mean > 0
const beatsAll = S.before?.mean > A.before?.mean && S.after?.mean > A.after?.mean
const sig = S.whole?.t != null && S.whole.t >= 2
console.log(`\nDECLARED BAR: above SPY in both periods ${beatsSpy} · above every member in both ${beatsAll} · t ≥ 2 ${sig} → ${beatsSpy && beatsAll && sig ? 'PASS' : 'FAIL'}`)
process.exit(0)
