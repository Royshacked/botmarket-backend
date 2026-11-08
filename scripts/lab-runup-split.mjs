// A DESCRIPTION, not a test (screener-lab.md §50, after test AA; Roy: "check which names the live hotlist serves"):
//   node --max-old-space-size=6000 scripts/lab-runup-split.mjs
// the live run-up rule on the lab's 3-year screener cache, split by S&P membership.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'
dns.setServers(['8.8.8.8', '1.1.1.1'])
const { prepare } = await import('../services/screenerLab.data.js')
const { HYPOTHESES, trade, blockRange } = await import('../services/screenerLab.service.js')
const { memberOn } = await import('../services/sp500History.service.js')
const sp = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
let raw = JSON.parse(fs.readFileSync('data/lab/screener-3y.json', 'utf8'))
const { history } = JSON.parse(fs.readFileSync('data/lab/screener.extras.json', 'utf8'))
const data = prepare(raw, { history }, { bench: 'spy' }); raw = null
const FROM = '2023-10-09', SPLIT = '2025-11-08', days = data.spyDays.filter(d => d >= FROM), want = new Set(days)
const h = HYPOTHESES.runup_5, out = []
for (const [symbol, s] of data.names) for (let i = 1; i < s.rows.length; i++) {
    if (!want.has(s.ind.date[i]) || !(s.rows[i - 1].close >= 5) || !((s.ind.adv20[i - 1] ?? 0) >= 5e6)) continue
    if (h.signal({ rows: s.rows, i, ind: s.ind, reports: s.reports, name: s, data }) !== '3 of 3 beat') continue
    if (!(data.regimes?.get(s.ind.date[i - 1]) ?? '').startsWith('SPY over')) continue
    const t = trade({ rows: s.rows, i, ind: s.ind, name: s, hold: h.hold, exit: h.exit, spyByDay: data.spyByDay })
    if (t) out.push({ symbol, sp: memberOn(sp.spans, symbol, t.day), adv: s.ind.adv20[i - 1], ...t })
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const f = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`)
const show = (label, ts) => { const b = blockRange(ts, days, 5); console.log(`${label.padEnd(30)} ${String(ts.length).padStart(5)} · net/trade ${f(mean(ts.map(t => t.net)))} · before ${f(mean(ts.filter(t => t.day < SPLIT).map(t => t.net)))} · held out ${f(mean(ts.filter(t => t.day >= SPLIT).map(t => t.net)))} · since 2024-11 ${f(mean(ts.filter(t => t.day >= '2024-11-01').map(t => t.net)))} · blocks ${b ? `${f(b.mean)} [${f(b.ci95[0])} … ${f(b.ci95[1])}]` : '—'}`) }
console.log(`${data.names.size} names · ${FROM} → ${days.at(-1)}`)
show('live rule, all', out)
show('  in the S&P that day', out.filter(t => t.sp))
show('  outside the S&P', out.filter(t => !t.sp))
show('  outside, $10M+ a day', out.filter(t => !t.sp && t.adv >= 10e6))
show('  outside, $5–10M a day', out.filter(t => !t.sp && t.adv < 10e6))
process.exit(0)
