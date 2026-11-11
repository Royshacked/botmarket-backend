// THE NATURE OF THE REPORT — Roy, 2026-11-09: "what about the nature of the reports? eps beat, revenue up, both?"
// Descriptive. Every report; the move is close D-1 → close D+1. Three periods as in lab-range-event-risers.mjs: the
// S&P 500 as it was 2019–22 and 2023–26 (range-event.sp500.rows.csv) and last year's broad universe
// (range-event.rows.csv). From FMP's history: EPS actual vs estimate, revenue actual vs estimate, and revenue against
// the report four back (y/y). No guidance in this data. Duplicate tickers not removed.
//
//   node scripts/lab-range-event-report.mjs → data/lab/range-event-report.out.txt
import fs from 'fs'

const load = (f) => {
    const [head, ...lines] = fs.readFileSync(f, 'utf8').trim().split('\n')
    const cols = head.split(',')
    return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v === '' ? null : isNaN(+v) ? v : +v]))).filter(r => r.react != null)
}
const sp = load('data/lab/range-event.sp500.rows.csv'), broad = load('data/lab/range-event.rows.csv')
const PERIODS = [['S&P 2019–22', sp.filter(r => r.report < '2023-01-01')], ['S&P 2023–26', sp.filter(r => r.report >= '2023-01-01')], ['broad last yr', broad]]
const out = [], say = (s = '') => { out.push(s); console.log(s) }
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo) }
const pc = (g, p) => `${Math.round((g.filter(p).length / g.length) * 100)}%`
const f = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`

const epsB = (r) => r.thisEpsSurp > 0, epsM = (r) => r.thisEpsSurp != null && r.thisEpsSurp <= 0
const revB = (r) => r.thisRevSurp > 0, revM = (r) => r.thisRevSurp != null && r.thisRevSurp <= 0
const grw = (r) => r.thisRevYoy > 0, shr = (r) => r.thisRevYoy != null && r.thisRevYoy <= 0

function table(title, groups) {
    say(`\n── ${title}`)
    say(''.padEnd(34) + PERIODS.map(([n]) => n.padStart(38)).join(''))
    say(''.padEnd(34) + PERIODS.map(() => 'n   share  up  +5%+  −5%−  median'.padStart(38)).join(''))
    for (const [lab, p] of groups) {
        const cells = PERIODS.map(([, all]) => {
            const known = all.filter(r => r.thisEpsSurp != null && r.thisRevSurp != null)
            const g = all.filter(p), m = g.map(r => r.react)
            if (g.length < 30) return (g.length ? `${g.length} (too few)` : '—').padStart(38)
            return `${String(g.length).padStart(5)} ${pc(known.filter(p), () => true) === '0%' ? '' : ''}${`${Math.round((g.length / known.length) * 100)}%`.padStart(6)} ${pc(g, r => r.react > 0).padStart(4)} ${pc(g, r => r.react >= 5).padStart(5)} ${pc(g, r => r.react <= -5).padStart(5)} ${f(q(m, 0.5)).padStart(7)}`.padStart(38)
        })
        say(lab.padEnd(34) + cells.join(''))
    }
}
say(`THE NATURE OF THE REPORT — the move close D-1 → D+1. "share" = of the reports with EPS and revenue both known.`)
table('EVERY REPORT', [['all', () => true]])
table('EPS vs estimate', [['EPS beat', epsB], ['EPS miss / in line', epsM]])
table('REVENUE vs estimate', [['revenue beat', revB], ['revenue miss / in line', revM]])
table('BOTH', [['EPS beat + revenue beat', r => epsB(r) && revB(r)], ['EPS beat + revenue miss', r => epsB(r) && revM(r)],
    ['EPS miss + revenue beat', r => epsM(r) && revB(r)], ['EPS miss + revenue miss', r => epsM(r) && revM(r)]])
table('REVENUE vs A YEAR AGO', [['revenue up y/y', grw], ['revenue down y/y', shr]])
table('BOTH BEATS, by revenue y/y', [['both beat + revenue up y/y', r => epsB(r) && revB(r) && grw(r)], ['both beat + revenue down y/y', r => epsB(r) && revB(r) && shr(r)]])
table('EPS SURPRISE SIZE', [['miss by 10%+', r => r.thisEpsSurp <= -10], ['miss 0 … 10%', r => r.thisEpsSurp > -10 && r.thisEpsSurp <= 0],
    ['beat 0 … 5%', r => r.thisEpsSurp > 0 && r.thisEpsSurp < 5], ['beat 5 … 15%', r => r.thisEpsSurp >= 5 && r.thisEpsSurp < 15], ['beat 15%+', r => r.thisEpsSurp >= 15]])
table('REVENUE SURPRISE SIZE', [['miss by 2%+', r => r.thisRevSurp <= -2], ['miss 0 … 2%', r => r.thisRevSurp > -2 && r.thisRevSurp <= 0],
    ['beat 0 … 2%', r => r.thisRevSurp > 0 && r.thisRevSurp < 2], ['beat 2 … 5%', r => r.thisRevSurp >= 2 && r.thisRevSurp < 5], ['beat 5%+', r => r.thisRevSurp >= 5]])
table('BOTH BEATS, by revenue surprise size', [['both beat, revenue 0 … 2%', r => epsB(r) && r.thisRevSurp > 0 && r.thisRevSurp < 2],
    ['both beat, revenue 2 … 5%', r => epsB(r) && r.thisRevSurp >= 2 && r.thisRevSurp < 5], ['both beat, revenue 5%+', r => epsB(r) && r.thisRevSurp >= 5]])
fs.writeFileSync('data/lab/range-event-report.out.txt', out.join('\n') + '\n')
