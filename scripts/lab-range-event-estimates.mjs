// THE ESTIMATE — Roy, 2026-11-09: "what about estimates?" FMP keeps one consensus per report (no revision history), so
// this reads the BAR it sets, known before the report: the growth it asks for against the same quarter a year ago
// (`estRevYoy`, `estEpsYoy`), and whether that is faster or slower than the growth the company just delivered
// (`estRevYoy − revYoy`: acceleration asked for). Per bucket, THIS report's result (both beat, revenue beat 5%+, both
// missed) and its move (close D-1 → D+1). Three periods as in lab-range-event-risers.mjs. Duplicate tickers not removed.
//
//   node scripts/lab-range-event-estimates.mjs → data/lab/range-event-estimates.out.txt
import fs from 'fs'

const load = (f) => {
    const [head, ...lines] = fs.readFileSync(f, 'utf8').trim().split('\n')
    const cols = head.split(',')
    return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v === '' ? null : isNaN(+v) ? v : +v])))
        .filter(r => r.react != null && r.thisEpsSurp != null && r.thisRevSurp != null)
}
const sp = load('data/lab/range-event.sp500.rows.csv'), broad = load('data/lab/range-event.rows.csv')
const PERIODS = [['S&P 2019–22', sp.filter(r => r.report < '2023-01-01')], ['S&P 2023–26', sp.filter(r => r.report >= '2023-01-01')], ['broad last yr', broad]]
const out = [], say = (s = '') => { out.push(s); console.log(s) }
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo) }
const pc = (g, p) => `${Math.round((g.filter(p).length / g.length) * 100)}%`
const f = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`

const COLS = 'n  both beat  rev 5%+  both miss │ up  +5%+  −5%−  median'
function table(title, groups) {
    say(`\n── ${title}`)
    say(''.padEnd(30) + PERIODS.map(([n]) => n.padStart(56)).join(''))
    say(''.padEnd(30) + PERIODS.map(() => COLS.padStart(56)).join(''))
    for (const [lab, p] of groups) {
        say(lab.padEnd(30) + PERIODS.map(([, all]) => {
            const g = all.filter(p)
            if (g.length < 30) return (g.length ? `${g.length} (too few)` : '—').padStart(56)
            return `${String(g.length).padStart(5)} ${pc(g, r => r.thisEpsSurp > 0 && r.thisRevSurp > 0).padStart(10)} ${pc(g, r => r.thisEpsSurp > 0 && r.thisRevSurp >= 5).padStart(8)} ${pc(g, r => r.thisEpsSurp <= 0 && r.thisRevSurp <= 0).padStart(10)} │ ${pc(g, r => r.react > 0).padStart(3)} ${pc(g, r => r.react >= 5).padStart(5)} ${pc(g, r => r.react <= -5).padStart(5)} ${f(q(g.map(r => r.react), 0.5)).padStart(7)}`.padStart(56)
        }).join(''))
    }
}
const cut = (k, edges, labels) => labels.map((lab, i) => [lab, r => r[k] != null && r[k] >= edges[i] && r[k] < edges[i + 1]])
say(`THE ESTIMATE'S BAR → THIS REPORT. Left of │: this report's result. Right of │: its move, close D-1 → D+1.`)
table('EVERY REPORT', [['all', () => true]])
table('REVENUE GROWTH THE ESTIMATE ASKS FOR (vs the same quarter a year ago)',
    cut('estRevYoy', [-Infinity, 0, 5, 10, 20, 40, Infinity], ['shrink', '0 … 5%', '5 … 10%', '10 … 20%', '20 … 40%', '40%+']))
table('EPS GROWTH THE ESTIMATE ASKS FOR (vs the same quarter a year ago, that quarter profitable)',
    cut('estEpsYoy', [-Infinity, -10, 0, 10, 25, 50, Infinity], ['down 10%+', '−10 … 0%', '0 … 10%', '10 … 25%', '25 … 50%', '50%+']))
const acc = (r) => (r.estRevYoy != null && r.revYoy != null ? r.estRevYoy - r.revYoy : null)
table('ACCELERATION ASKED FOR: estimate\'s revenue y/y minus the last quarter\'s actual y/y (points)',
    [['slows 10+ pts', r => acc(r) != null && acc(r) <= -10], ['slows 3 … 10', r => acc(r) > -10 && acc(r) <= -3], ['about the same (±3)', r => acc(r) > -3 && acc(r) < 3],
        ['speeds up 3 … 10', r => acc(r) >= 3 && acc(r) < 10], ['speeds up 10+ pts', r => acc(r) >= 10]])
table('THE BAR × THE TRACK RECORD (revenue)', [
    ['low bar (<5% y/y), beat 4/4', r => r.estRevYoy != null && r.estRevYoy < 5 && r.beats4 === 4],
    ['high bar (20%+), beat 4/4', r => r.estRevYoy >= 20 && r.beats4 === 4],
    ['low bar, beat ≤ 2/4', r => r.estRevYoy != null && r.estRevYoy < 5 && r.beats4 != null && r.beats4 <= 2],
    ['high bar, beat ≤ 2/4', r => r.estRevYoy >= 20 && r.beats4 != null && r.beats4 <= 2]])
fs.writeFileSync('data/lab/range-event-estimates.out.txt', out.join('\n') + '\n')
