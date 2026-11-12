// THE COMPRESSED GROUP, YEAR BY YEAR — Roy, 2026-11-09: "run the prev years". Reads a rows file from
// lab-range-event.mjs (default the S&P 500 as it was, 2019 → 2026: range-event.sp500.rows.csv; --src=broad for last
// year's broad universe). Duplicate tickers NOT removed (Roy's call).
//
// Groups (lab-range-event-compressed.mjs): compressed = sideways ±5% over the 2 months, range < 0.6× its own usual,
// takeover-pinned out (range < 6% or daily ATR < 0.6%); normal sideways = the same at 0.8–1.2×; every report.
// Per report year: the report (|move| > 10%, up), the month after vs SPY, report → next report vs SPY.
//
//   node scripts/lab-range-event-years.mjs [--src=broad] → data/lab/range-event-years[.broad].out.txt
import fs from 'fs'

const SRC = process.argv.find(a => a.startsWith('--src='))?.slice(6) ?? 'sp500'
const IN = SRC === 'broad' ? 'data/lab/range-event.rows.csv' : 'data/lab/range-event.sp500.rows.csv'
const OUT = `data/lab/range-event-years${SRC === 'broad' ? '.broad' : ''}.out.txt`
const [head, ...lines] = fs.readFileSync(IN, 'utf8').trim().split('\n')
const cols = head.split(',')
const rows = lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v === '' ? null : isNaN(+v) ? v : +v])))
const out = [], say = (s = '') => { out.push(s); console.log(s) }
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo) }
const f = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`)

const ok = (r) => r.relWidth != null && Math.abs(r.netChange) <= 5 && r.width >= 6 && r.atrPct >= 0.6
const GROUPS = [['compressed', r => ok(r) && r.relWidth < 0.6], ['normal sideways', r => ok(r) && r.relWidth >= 0.8 && r.relWidth < 1.2], ['every report', () => true]]
function stats(g) {
    const v = (k) => g.map(r => r[k]).filter(x => x != null)
    const re = v('react'), af = v('afterX'), tn = v('toNextX')
    const share = (xs, p) => (xs.length ? Math.round((xs.filter(p).length / xs.length) * 100) + '%' : '—')
    return [String(g.length), share(re, x => Math.abs(x) > 10), share(re, x => x > 0),
        af.length ? f(q(af, 0.5)) : '—', share(af, x => x > 0), tn.length ? f(q(tn, 0.5)) : '—', share(tn, x => x > 0), String(tn.length)]
}
const HEAD = ['n', 'rpt >10%', 'rpt up', 'month med', 'month beat', 'to-next med', 'to-next beat', 'to-next n']
const W = [6, 10, 8, 11, 11, 12, 13, 10]
const row = (lab, cells) => lab.padEnd(26) + cells.map((c, i) => c.padStart(W[i])).join('')

say(`THE COMPRESSED GROUP, YEAR BY YEAR — ${IN}: ${rows.length} reports, ${rows.map(r => r.report).sort()[0]} → ${rows.map(r => r.report).sort().at(-1)}`)
say('"month" = D+1 → D+20 minus SPY; "to-next" = D+1 → the close before the next report, minus SPY; "beat" = above SPY.')
const years = [...new Set(rows.map(r => r.report.slice(0, 4)))].sort()
for (const y of [...years, 'ALL']) {
    const ys = y === 'ALL' ? rows : rows.filter(r => r.report.startsWith(y))
    say(`\n── ${y}`)
    say(row('', HEAD))
    for (const [n, p] of GROUPS) say(row(n, stats(ys.filter(p))))
}

say(`\n── SUMMARY: compressed minus every report, by year (percentage points of "beat SPY")`)
say('year'.padEnd(8) + 'compressed n'.padStart(14) + 'month beat Δ'.padStart(14) + 'to-next beat Δ'.padStart(16) + 'to-next med Δ'.padStart(15))
for (const y of [...years, 'ALL']) {
    const ys = y === 'ALL' ? rows : rows.filter(r => r.report.startsWith(y))
    const c = ys.filter(GROUPS[0][1])
    const beat = (g, k) => { const v = g.map(r => r[k]).filter(x => x != null); return v.length ? (v.filter(x => x > 0).length / v.length) * 100 : null }
    const med = (g, k) => { const v = g.map(r => r[k]).filter(x => x != null); return v.length ? q(v, 0.5) : null }
    const d = (a, b) => (a == null || b == null ? '—' : `${a - b >= 0 ? '+' : ''}${(a - b).toFixed(0)}`)
    say(y.padEnd(8) + String(c.length).padStart(14) + d(beat(c, 'afterX'), beat(ys, 'afterX')).padStart(14) + d(beat(c, 'toNextX'), beat(ys, 'toNextX')).padStart(16)
        + (med(c, 'toNextX') == null ? '—' : `${(med(c, 'toNextX') - med(ys, 'toNextX')).toFixed(1)}`).padStart(15))
}
fs.writeFileSync(OUT, out.join('\n') + '\n')
