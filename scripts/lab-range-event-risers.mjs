// WHAT THE RISERS HAVE IN COMMON — Roy, 2026-11-09: "the stocks that rose after reports — do they have anything in
// common? technical / industry / cap / last reports". Descriptive. Every report, not only the compressed ones.
//
// A riser: close D-1 → close D+1 ≥ +5%; a faller: ≤ −5%. Each trait (all known on the scan day, 5 sessions before the
// report) is cut into fixed buckets; per bucket the share of risers and of fallers, in three periods that never share
// a report: the S&P 500 as it was 2019–2022 and 2023–2026 (range-event.sp500.rows.csv) and last year's broad universe
// (range-event.rows.csv). A bucket is CONSISTENT when its riser share is 3+ points above (or below) its period's base
// in all three. `beatThis` is the report itself — known only after it, shown apart. Duplicate tickers not removed.
//
//   node scripts/lab-range-event-risers.mjs → data/lab/range-event-risers.out.txt
import fs from 'fs'

const load = (f) => {
    const [head, ...lines] = fs.readFileSync(f, 'utf8').trim().split('\n')
    const cols = head.split(',')
    return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v === '' ? null : isNaN(+v) ? v : +v]))).filter(r => r.react != null)
}
const sp = load('data/lab/range-event.sp500.rows.csv'), broad = load('data/lab/range-event.rows.csv')
const PERIODS = [['S&P 2019–22', sp.filter(r => r.report < '2023-01-01')], ['S&P 2023–26', sp.filter(r => r.report >= '2023-01-01')], ['broad last yr', broad]]
const out = [], say = (s = '') => { out.push(s); console.log(s) }
const up = (r) => r.react >= 5, dn = (r) => r.react <= -5
const rate = (g, p) => (g.length ? (g.filter(p).length / g.length) * 100 : null)
const BASE = PERIODS.map(([, g]) => [rate(g, up), rate(g, dn)])

const num = (k, edges, labels) => ({ key: k, buckets: labels.map((lab, i) => [lab, r => r[k] != null && r[k] >= edges[i] && r[k] < edges[i + 1]]) })
const TRAITS = [
    ['— INDUSTRY / SIZE —'],
    ['sector', { buckets: [...new Set([...sp, ...broad].map(r => r.sector || '(none)'))].sort().map(s => [s, r => (r.sector || '(none)') === s]) }],
    ['revenue, last 4 qtrs ($B)', num('revTtmB', [0, 1, 5, 20, 100, Infinity], ['< 1', '1–5', '5–20', '20–100', '100+'])],
    ['price ($)', num('price', [0, 20, 50, 150, Infinity], ['< 20', '20–50', '50–150', '150+'])],
    ['in the S&P 500 (broad only)', { buckets: [['yes', r => r.sp500 === 1], ['no', r => r.sp500 === 0]] }],
    ['— TECHNICAL —'],
    ['daily ATR % of price', num('atrPct', [0, 1.5, 2.5, 4, Infinity], ['< 1.5%', '1.5–2.5%', '2.5–4%', '4%+'])],
    ['change, last 5 sessions to scan (pre5 excl.) → 2 months', num('netChange', [-Infinity, -15, -5, 5, 15, Infinity], ['< −15%', '−15 … −5%', '−5 … +5%', '+5 … +15%', '+15%+'])],
    ['change, the 5 sessions before the report', num('pre5', [-Infinity, -3, 0, 3, Infinity], ['< −3%', '−3 … 0%', '0 … +3%', '+3%+'])],
    ['change, 6 months', num('chg126', [-Infinity, -20, 0, 20, 50, Infinity], ['< −20%', '−20 … 0%', '0 … +20%', '+20 … +50%', '+50%+'])],
    ['change, 12 months', num('chg252', [-Infinity, -20, 0, 20, 50, Infinity], ['< −20%', '−20 … 0%', '0 … +20%', '+20 … +50%', '+50%+'])],
    ['from the 52-week high', num('from52wHigh', [-Infinity, -30, -15, -5, Infinity], ['< −30%', '−30 … −15%', '−15 … −5%', 'within 5%'])],
    ['vs the 200-day average', num('vs200', [-Infinity, -10, 0, 10, Infinity], ['< −10%', '−10 … 0%', '0 … +10%', '+10%+'])],
    ['vs the 50-day average', num('vs50', [-Infinity, -5, 0, 5, Infinity], ['< −5%', '−5 … 0%', '0 … +5%', '+5%+'])],
    ['2-month range vs its own usual', num('relWidth', [0, 0.6, 0.8, 1.2, Infinity], ['< 0.6×', '0.6–0.8×', '0.8–1.2×', '1.2×+'])],
    ['where in the 2-month range', num('posInRange', [0, 1 / 3, 2 / 3, 1.0001], ['bottom third', 'middle', 'top third'])],
    ['— LAST REPORTS —'],
    ['EPS beats in the last 4', num('beats4', [0, 2, 3, 4, 5], ['0–1', '2', '3', '4 of 4'])],
    ['last EPS surprise', num('lastSurprise', [-Infinity, 0, 5, 15, Infinity], ['miss', '0–5%', '5–15%', '15%+'])],
    ['last revenue surprise', num('lastRevSurprise', [-Infinity, 0, 2, 5, Infinity], ['miss', '0–2%', '2–5%', '5%+'])],
    ['last report move', num('prevReactS', [-Infinity, -5, 0, 5, Infinity], ['down 5%+', '−5 … 0%', '0 … +5%', 'up 5%+'])],
    ['revenue growth y/y', num('revYoy', [-Infinity, 0, 10, 25, Infinity], ['shrinking', '0–10%', '10–25%', '25%+'])],
    ['profitable last quarter', { buckets: [['yes', r => r.profitable === 1], ['no', r => r.profitable === 0]] }],
    ['— THE REPORT ITSELF (known only after it) —'],
    ['beat EPS this report', { buckets: [['beat', r => r.beatThis === 1], ['miss / in line', r => r.beatThis === 0]] }],
]

say(`WHAT THE RISERS HAVE IN COMMON — riser: report move (close D-1 → D+1) ≥ +5%; faller ≤ −5%.`)
say(`Base rates — ${PERIODS.map(([n, g], i) => `${n}: ${g.length} reports, risers ${BASE[i][0].toFixed(0)}%, fallers ${BASE[i][1].toFixed(0)}%`).join(' · ')}`)
say(`Each cell: n · risers% (Δ vs that period's base) · fallers%. ✓ = risers 3+ points above base in all three, ✗ = 3+ below in all three.`)
const consistent = []
for (const [name, t] of TRAITS) {
    if (!t) { say(`\n${name}`); continue }
    say(`\n── ${name}`)
    say(''.padEnd(24) + PERIODS.map(([n]) => n.padStart(30)).join(''))
    for (const [lab, p] of t.buckets) {
        const cells = PERIODS.map(([, g], i) => {
            const b = g.filter(p)
            if (b.length < 30) return { txt: b.length ? `${b.length} · (too few)` : '—', d: null }
            const u = rate(b, up), d = rate(b, dn), du = u - BASE[i][0]
            return { txt: `${b.length} · ${u.toFixed(0)}% (${du >= 0 ? '+' : ''}${du.toFixed(0)}) · ${d.toFixed(0)}%`, d: du }
        })
        const ds = cells.map(c => c.d)
        const mark = ds.every(x => x != null && x >= 3) ? ' ✓' : ds.every(x => x != null && x <= -3) ? ' ✗' : ''
        if (mark) consistent.push(`${mark.trim()} ${name}: ${lab} (${ds.map(x => (x >= 0 ? '+' : '') + x.toFixed(0)).join(' / ')})`)
        say(lab.padEnd(24) + cells.map(c => c.txt.padStart(30)).join('') + mark)
    }
}
say(`\n══ CONSISTENT IN ALL THREE PERIODS (riser share vs base, points: S&P 19–22 / S&P 23–26 / broad)`)
for (const c of consistent) say('  ' + c)
fs.writeFileSync('data/lab/range-event-risers.out.txt', out.join('\n') + '\n')
