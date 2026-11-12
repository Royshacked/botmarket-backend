// THE RUN-UP AS THE MARKET'S EXPECTATION — Roy, 2026-11-09 (option 3 of "what about estimates"). If the price carries
// what the market expects, a stock that ran up into the report should react LESS to a beat and MORE to a miss, and one
// sold off into it the other way round. The run-up: the stock minus SPY over the 5, 20 and 60 sessions to close D-1
// (`pre5X`, `pre20X`, `pre60X`). Crossed with THIS report's result (both beat / mixed / both missed — known only after)
// and, alone, against the move (known before). Move = close D-1 → D+1. Three periods as in lab-range-event-risers.mjs.
//
//   node scripts/lab-range-event-runup.mjs → data/lab/range-event-runup.out.txt
import fs from 'fs'

const load = (f) => {
    const [head, ...lines] = fs.readFileSync(f, 'utf8').trim().split('\n')
    const cols = head.split(',')
    return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v === '' ? null : isNaN(+v) ? v : +v])))
        .filter(r => r.react != null)
}
const sp = load('data/lab/range-event.sp500.rows.csv'), broad = load('data/lab/range-event.rows.csv')
const PERIODS = [['S&P 2019–22', sp.filter(r => r.report < '2023-01-01')], ['S&P 2023–26', sp.filter(r => r.report >= '2023-01-01')], ['broad last yr', broad]]
const out = [], say = (s = '') => { out.push(s); console.log(s) }
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo) }
const pc = (g, p) => `${Math.round((g.filter(p).length / g.length) * 100)}%`
const f = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`

const RESULTS = [['both beat', r => r.thisEpsSurp > 0 && r.thisRevSurp > 0], ['mixed', r => r.thisEpsSurp != null && r.thisRevSurp != null && (r.thisEpsSurp > 0) !== (r.thisRevSurp > 0)],
    ['both missed', r => r.thisEpsSurp != null && r.thisRevSurp != null && r.thisEpsSurp <= 0 && r.thisRevSurp <= 0], ['any result', () => true]]
const bucketsFor = (k, e) => [[`< −${e[1]}%`, r => r[k] < -e[1]], [`−${e[1]} … −${e[0]}%`, r => r[k] >= -e[1] && r[k] < -e[0]], [`±${e[0]}%`, r => r[k] >= -e[0] && r[k] <= e[0]],
    [`+${e[0]} … +${e[1]}%`, r => r[k] > e[0] && r[k] <= e[1]], [`> +${e[1]}%`, r => r[k] > e[1]]]
const WINDOWS = [['5 sessions', 'pre5X', [2, 5]], ['20 sessions', 'pre20X', [3, 10]], ['60 sessions', 'pre60X', [5, 15]]]

const cell = (g) => (g.length < 30 ? (g.length ? `${g.length} (few)` : '—').padStart(30)
    : `${String(g.length).padStart(5)} ${pc(g, r => r.react > 0).padStart(4)} ${pc(g, r => r.react >= 5).padStart(4)} ${pc(g, r => r.react <= -5).padStart(4)} ${f(q(g.map(r => r.react), 0.5)).padStart(7)}`.padStart(30))
say(`THE RUN-UP INTO THE REPORT (stock minus SPY to close D-1) × THIS REPORT'S RESULT → the move, close D-1 → D+1.`)
say(`Each cell: n · up · +5%+ · −5%− · median.`)
for (const [wn, k, e] of WINDOWS) {
    for (const [rn, rp] of RESULTS) {
        say(`\n── run-up over ${wn} — report: ${rn}`)
        say('run-up vs SPY'.padEnd(16) + PERIODS.map(([n]) => n.padStart(30)).join(''))
        for (const [bn, bp] of bucketsFor(k, e)) say(bn.padEnd(16) + PERIODS.map(([, g]) => cell(g.filter(r => r[k] != null && rp(r) && bp(r)))).join(''))
    }
}
// The spread the hypothesis predicts: within each result, the median move after a sell-off minus after a run-up.
say(`\n══ MEDIAN MOVE, SOLD OFF (lowest bucket) MINUS RAN UP (highest bucket), within each result — positive = "priced in"`)
say('window / result'.padEnd(30) + PERIODS.map(([n]) => n.padStart(16)).join(''))
for (const [wn, k, e] of WINDOWS) for (const [rn, rp] of RESULTS) {
    const b = bucketsFor(k, e)
    say(`${wn} / ${rn}`.padEnd(30) + PERIODS.map(([, g]) => {
        const lo = g.filter(r => r[k] != null && rp(r) && b[0][1](r)).map(r => r.react), hi = g.filter(r => r[k] != null && rp(r) && b[4][1](r)).map(r => r.react)
        return (lo.length >= 30 && hi.length >= 30 ? `${(q(lo, 0.5) - q(hi, 0.5) >= 0 ? '+' : '')}${(q(lo, 0.5) - q(hi, 0.5)).toFixed(1)} pts` : '—').padStart(16)
    }).join(''))
}
fs.writeFileSync('data/lab/range-event-runup.out.txt', out.join('\n') + '\n')
