// THE HOLD'S LENGTH AFTER A REPORT — test Q (declared in screener-lab.md §35, before the run). §32's entries (day two),
// held 5 / 10 / 20 / 40 sessions or to the next report, by the report's quality.
//
//   node --max-old-space-size=6000 scripts/lab-hold-sweep.mjs
//
// Offline: data/lab caches.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { holdTrades, holdBook, bookBlocks } = await import('../services/holdToNext.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const FROM = '2020-01-01', SPLIT = '2024-01-01', HOLDS = [5, 10, 20, 40, 'next']
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
await closeDb()
const base = holdTrades(data, { from: FROM, member }).trades
for (const t of base) {
    const s = data.names.get(t.symbol), rep = s.reports.get(s.ind.date[t.i - 2])
    const a = Number(rep?.revenueActual), e = Number(rep?.revenueEstimated)
    t.rev = a > 0 && e > 0 ? (a / e - 1) * 100 : null
}
const days = data.spyDays.filter(d => d >= FROM)
const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)

/** The trade held `h` sessions (or to the next report), never past the close before the next report. */
function heldFor(t, h) {
    if (h === 'next') return t
    const x = Math.min(t.i + h - 1, t.x)
    const s = data.names.get(t.symbol), s0 = data.spyByDay.get(s.ind.date[t.i]), s1 = data.spyByDay.get(s.ind.date[x])
    const ret = pct(s.rows[x].close, s.rows[t.i].open), spy = pct(s1?.close, s0?.open)
    if (ret == null || spy == null) return null
    return { ...t, x, held: x - t.i + 1, ret, spy, net: ret - spy - t.cost }
}
const GROUPS = {
    'every report': () => true,
    'good (EPS + revenue)': (t) => t.good,
    'revenue beat 10%+': (t) => t.rev != null && t.rev >= 10,
    'EPS beat over 10%': (t) => t.band === 'big beat',
}
const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }

const res = {}
for (const [g, keep] of Object.entries(GROUPS)) {
    res[g] = {}
    for (const h of HOLDS) {
        const ts = base.filter(keep).map(t => heldFor(t, h)).filter(Boolean)
        const b = holdBook(data, ts)
        res[g][h] = { ts, whole: bookBlocks(b, days), before: bookBlocks(b, days.filter(d => d < SPLIT)), after: bookBlocks(b, days.filter(d => d >= SPLIT)) }
    }
}
console.log(`${base.length} reports · entries ${FROM} →, split ${SPLIT} · book per month (each session once), net of SPY and the cost`)
for (const [g, byH] of Object.entries(res)) {
    console.log(`\n── ${g}`)
    for (const h of HOLDS) {
        const r = byH[h], net = r.ts.map(t => t.net)
        console.log(`  hold ${String(h).padStart(4)} · ${String(r.ts.length).padStart(5)} · per hold ${f2(mean(net))} median ${f2(median(net))} beat SPY ${(r.ts.filter(t => t.net > 0).length / r.ts.length * 100).toFixed(0)}% · book/mo ${f2(r.whole?.mean)} t ${r.whole?.t?.toFixed(2) ?? '—'} · before ${f2(r.before?.mean)} after ${f2(r.after?.mean)}`)
    }
}

// THE DECLARED BAR.
console.log('\nDECLARED BAR (per group and length: above SPY both periods · above every report both · t ≥ 2 · a neighbour the same way)')
const ok = (g, h) => res[g][h].before?.mean > 0 && res[g][h].after?.mean > 0
for (const g of Object.keys(GROUPS).filter(g => g !== 'every report')) {
    const marks = HOLDS.map((h, n) => {
        const r = res[g][h], all = res['every report'][h]
        const spy = ok(g, h)
        const ctl = r.before?.mean > all.before?.mean && r.after?.mean > all.after?.mean
        const sig = r.whole?.t != null && r.whole.t >= 2
        const nb = [HOLDS[n - 1], HOLDS[n + 1]].filter(x => x !== undefined).some(x => ok(g, x))
        return `${h}: ${spy && ctl && sig && nb ? 'PASS' : 'fail'} (${[spy && 'spy', ctl && 'ctl', sig && 't', nb && 'nb'].filter(Boolean).join('+') || '—'})`
    })
    console.log(`  ${g.padEnd(22)} ${marks.join(' · ')}`)
}
process.exit(0)
