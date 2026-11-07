// WHAT THE HOLDS THAT BEAT SPY HAD IN COMMON (Roy, 2026-11-07: "from our trades try to find how we beat the spy and then
// check what is common between those stocks"). §32's holds (the S&P 500 as it was, a report → the next one). Only facts
// KNOWN AT THE ENTRY OPEN: the movers study's 27 (moverDiff featuresAt, at the reaction day's close) and the report's own.
// Each fact is read on 2020–2023 and checked on 2024 →: a trait that only describes one period is hindsight.
//
//   node --max-old-space-size=6000 scripts/lab-hold-winners.mjs
//
// Offline: data/lab caches + data/lab/guidance-8k.jsonl.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { guidanceDirection } = await import('../services/guidance8k.service.js')
const { holdTrades } = await import('../services/holdToNext.service.js')
const { reactionAt } = await import('../services/reportReaction.service.js')
const { featuresAt, FEATURES, fitAndScore } = await import('../services/moverDiff.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const SPLIT = '2024-01-01'
const guidanceOf = new Map(fs.readFileSync('data/lab/guidance-8k.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .map(r => [`${r.symbol} ${r.report}`, r.miss ? 'missing' : guidanceDirection(r)]))
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
await closeDb()

// The report's own facts, beside the 27.
const OWN = ['surprise', 'rev_surprise', 'reaction', 'hold_length']
const ALL = [...FEATURES.filter(k => k !== 'report_in_week' && k !== 'days_since_report'), ...OWN]
const trades = holdTrades(data, { from: '2020-01-01', member }).trades
for (const t of trades) {
    const s = data.names.get(t.symbol), k = t.i - 2, rep = s.reports.get(s.ind.date[k])
    const f = featuresAt(s, data, t.i - 1, t.i, t.i)
    const ra = Number(rep?.revenueActual), re = Number(rep?.revenueEstimated)
    Object.assign(f, {
        surprise: t.surprise, rev_surprise: ra > 0 && re > 0 ? (ra / re - 1) * 100 : null, reaction: reactionAt(s, k, data),
        // The next report's date is on the calendar weeks ahead, so the hold's length is known at entry too.
        hold_length: t.ended ? null : t.held,
    })
    t.f = f
    t.guidance = guidanceOf.get(`${t.symbol} ${s.ind.date[k]}`) ?? 'not fetched'
    t.sector = s.sector ?? 'unknown'
    t.win = t.net > 0
}
const before = trades.filter(t => t.day < SPLIT), after = trades.filter(t => t.day >= SPLIT)
const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const winRate = (ts) => (ts.length ? `${(ts.filter(t => t.win).length / ts.length * 100).toFixed(0)}%` : '—').padStart(4)

/** The chance a random winner's fact is over a random loser's (ties half). Pure. */
function auc(ts, key) {
    const v = ts.filter(t => Number.isFinite(t.f[key])).map(t => ({ x: t.f[key], w: t.win })).sort((a, b) => a.x - b.x)
    let sumW = 0, nW = 0
    for (let n = 0; n < v.length;) {
        let m = n
        while (m < v.length && v[m].x === v[n].x) m++
        const r = (n + 1 + m) / 2
        for (let q = n; q < m; q++) if (v[q].w) { sumW += r; nW++ }
        n = m
    }
    const nL = v.length - nW
    return nW && nL ? (sumW - nW * (nW + 1) / 2) / (nW * nL) : null
}
/** The cut points of `key` from the 2020–2023 trades: their quintiles, used unchanged on 2024 →. */
const cuts = (key) => { const v = before.map(t => t.f[key]).filter(Number.isFinite).sort((a, b) => a - b); return [1, 2, 3, 4].map(q => v[Math.floor(q * v.length / 5)]) }
const binOf = (x, c) => (Number.isFinite(x) ? c.filter(p => x >= p).length : null)

console.log(`${trades.length} holds · beat SPY ${winRate(trades)} · 2020–2023 ${before.length} (beat ${winRate(before)}) · 2024 → ${after.length} (beat ${winRate(after)})`)
console.log('\n── EACH FACT: AUC (over 0.5 = winners had MORE of it) in both periods, and the net of its bottom and top fifth (cut on 2020–2023)')
const rows = []
for (const key of ALL) {
    const a1 = auc(before, key), a2 = auc(after, key), c = cuts(key)
    const q = (ts, b) => ts.filter(t => binOf(t.f[key], c) === b)
    rows.push({ key, a1, a2, low1: mean(q(before, 0).map(t => t.net)), high1: mean(q(before, 4).map(t => t.net)), low2: mean(q(after, 0).map(t => t.net)), high2: mean(q(after, 4).map(t => t.net)), c })
}
rows.sort((a, b) => Math.abs((b.a1 ?? 0.5) - 0.5) + Math.abs((b.a2 ?? 0.5) - 0.5) - Math.abs((a.a1 ?? 0.5) - 0.5) - Math.abs((a.a2 ?? 0.5) - 0.5))
for (const r of rows) {
    const same = r.a1 != null && r.a2 != null && (r.a1 - 0.5) * (r.a2 - 0.5) > 0 && Math.abs(r.a1 - 0.5) >= 0.02 && Math.abs(r.a2 - 0.5) >= 0.02
    console.log(`  ${same ? '◆' : ' '} ${r.key.padEnd(16)} AUC ${r.a1?.toFixed(3) ?? '—'} → ${r.a2?.toFixed(3) ?? '—'} · bottom fifth ${f2(r.low1)} → ${f2(r.low2)} · top fifth ${f2(r.high1)} → ${f2(r.high2)} · cuts ${r.c.map(x => x?.toFixed(1)).join(' / ')}`)
}
console.log('  ◆ = winners differ the same way in both periods by 0.02+ of AUC')

console.log('\n── SECTOR (net per hold, beat SPY) 2020–2023 → 2024 →')
for (const sec of [...new Set(trades.map(t => t.sector))].sort()) {
    const b = before.filter(t => t.sector === sec), a = after.filter(t => t.sector === sec)
    if (b.length + a.length < 60) continue
    console.log(`  ${sec.padEnd(24)} ${String(b.length).padStart(5)} ${f2(mean(b.map(t => t.net)))} ${winRate(b)} → ${String(a.length).padStart(5)} ${f2(mean(a.map(t => t.net)))} ${winRate(a)}`)
}
console.log('\n── GUIDANCE (net per hold, beat SPY) 2020–2023 → 2024 →')
for (const g of ['raise', 'maintain', 'cut', 'mixed', 'numbers', 'none', 'missing']) {
    const b = before.filter(t => t.guidance === g), a = after.filter(t => t.guidance === g)
    console.log(`  ${g.padEnd(10)} ${String(b.length).padStart(5)} ${f2(mean(b.map(t => t.net)))} ${winRate(b)} → ${String(a.length).padStart(5)} ${f2(mean(a.map(t => t.net)))} ${winRate(a)}`)
}

// THE TWO FACTS THAT HELD (added after the first run, so descriptions): is high volatility just risk — does it hold in the
// falling year, 2022? And the big revenue beat, counted as a book (each session once), not per hold.
const { holdBook, bookBlocks } = await import('../services/holdToNext.service.js')
const days = data.spyDays.filter(d => d >= '2020-01-01')
const book = (ts) => { const b = holdBook(data, ts), w = bookBlocks(b, days); return `book/mo ${f2(w?.mean)} t ${w?.t?.toFixed(2) ?? '—'} · before ${f2(bookBlocks(b, days.filter(d => d < SPLIT))?.mean)} after ${f2(bookBlocks(b, days.filter(d => d >= SPLIT))?.mean)}` }
for (const key of ['volatility', 'rev_surprise']) {
    const c = cuts(key), top = trades.filter(t => binOf(t.f[key], c) === 4), bottom = trades.filter(t => binOf(t.f[key], c) === 0)
    console.log(`\n── ${key}: top fifth (≥ ${c[3].toFixed(1)}) against the bottom fifth (< ${c[0].toFixed(1)}), by the year bought`)
    for (const y of [...new Set(trades.map(t => t.day.slice(0, 4)))].sort()) {
        const a = top.filter(t => t.day.startsWith(y)), b = bottom.filter(t => t.day.startsWith(y))
        const spy = mean(trades.filter(t => t.day.startsWith(y)).map(t => t.spy))
        console.log(`  ${y} SPY over the holds ${f2(spy)} · top ${String(a.length).padStart(4)} ${f2(mean(a.map(t => t.net)))} ${winRate(a)} · bottom ${String(b.length).padStart(4)} ${f2(mean(b.map(t => t.net)))} ${winRate(b)}`)
    }
    console.log(`  top fifth ${book(top)}`)
    console.log(`  bottom fifth ${book(bottom)}`)
}

// Every fact at once: fitted on 2020–2023, scored on 2024 → (moverDiff's logistic model, held-out deciles).
const movers = trades.map(t => ({ week: t.day, symbol: t.symbol, up: t.win, net: t.net, f: t.f, x: Float32Array.from(ALL, k => (Number.isFinite(t.f[k]) ? t.f[k] : NaN)) }))
const fit = fitAndScore(movers, SPLIT, { features: ALL })
console.log(`\n── ALL FACTS TOGETHER — fitted on 2020–2023 (${fit.train}), scored on 2024 → (${fit.held.n}): AUC ${fit.held.auc}`)
console.log(`  heaviest weights: ${Object.entries(fit.weights).slice(0, 8).map(([k, w]) => `${k} ${w}`).join(' · ')}`)
fit.held.deciles.forEach((d, n) => console.log(`  decile ${String(n + 1).padStart(2)} (score low → high): ${String(d.n).padStart(5)} · beat SPY ${String(d.up).padStart(5)}% · net ${f2(d.net_mean)}`))
process.exit(0)
