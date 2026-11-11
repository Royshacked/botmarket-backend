// THE PREVIOUS REPORT — Roy, 2026-11-09: "what about prev report?" Does the last report's result (EPS / revenue vs the
// estimate) or its move predict THIS report's result, and this report's move? Descriptive. Three periods as in
// lab-range-event-risers.mjs. The previous report = the last one before D with a revenue actual (`lastSurprise`,
// `lastRevSurprise`, `prevReactS`); this one = `thisEpsSurp`, `thisRevSurp`, `react`. Duplicate tickers not removed.
//
//   node scripts/lab-range-event-prev.mjs → data/lab/range-event-prev.out.txt
import fs from 'fs'

const load = (f) => {
    const [head, ...lines] = fs.readFileSync(f, 'utf8').trim().split('\n')
    const cols = head.split(',')
    return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v === '' ? null : isNaN(+v) ? v : +v])))
        .filter(r => r.react != null && r.thisEpsSurp != null && r.thisRevSurp != null && r.lastSurprise != null && r.lastRevSurprise != null)
}
const sp = load('data/lab/range-event.sp500.rows.csv'), broad = load('data/lab/range-event.rows.csv')
const PERIODS = [['S&P 2019–22', sp.filter(r => r.report < '2023-01-01')], ['S&P 2023–26', sp.filter(r => r.report >= '2023-01-01')], ['broad last yr', broad]]
const out = [], say = (s = '') => { out.push(s); console.log(s) }
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo) }
const pc = (g, p) => `${Math.round((g.filter(p).length / g.length) * 100)}%`
const f = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`

const bothBeatThis = (r) => r.thisEpsSurp > 0 && r.thisRevSurp > 0
const bigBeatThis = (r) => r.thisEpsSurp > 0 && r.thisRevSurp >= 5
const bothMissThis = (r) => r.thisEpsSurp <= 0 && r.thisRevSurp <= 0
const COLS = 'n  both beat  rev 5%+  both miss │ up  +5%+  −5%−  median'
function table(title, groups) {
    say(`\n── ${title}`)
    say(''.padEnd(32) + PERIODS.map(([n]) => n.padStart(56)).join(''))
    say(''.padEnd(32) + PERIODS.map(() => COLS.padStart(56)).join(''))
    for (const [lab, p] of groups) {
        say(lab.padEnd(32) + PERIODS.map(([, all]) => {
            const g = all.filter(p)
            if (g.length < 30) return (g.length ? `${g.length} (too few)` : '—').padStart(56)
            return `${String(g.length).padStart(5)} ${pc(g, bothBeatThis).padStart(10)} ${pc(g, bigBeatThis).padStart(8)} ${pc(g, bothMissThis).padStart(10)} │ ${pc(g, r => r.react > 0).padStart(3)} ${pc(g, r => r.react >= 5).padStart(5)} ${pc(g, r => r.react <= -5).padStart(5)} ${f(q(g.map(r => r.react), 0.5)).padStart(7)}`.padStart(56)
        }).join(''))
    }
}
say(`THE PREVIOUS REPORT → THIS ONE. Left of │: THIS report's result — both beat (EPS + revenue), "rev 5%+" = EPS beat and`)
say(`revenue beat by 5%+, both missed. Right of │: THIS report's move, close D-1 → D+1.`)
table('EVERY REPORT', [['all', () => true]])
const pb = (r) => r.lastSurprise > 0 && r.lastRevSurprise > 0, pm = (r) => r.lastSurprise <= 0 && r.lastRevSurprise <= 0
table('THE PREVIOUS REPORT\'S RESULT', [['prev: both beat', pb], ['prev: EPS beat, revenue miss', r => r.lastSurprise > 0 && r.lastRevSurprise <= 0],
    ['prev: EPS miss, revenue beat', r => r.lastSurprise <= 0 && r.lastRevSurprise > 0], ['prev: both miss', pm]])
table('THE PREVIOUS REVENUE BEAT\'S SIZE', [['prev: revenue miss by 2%+', r => r.lastRevSurprise <= -2], ['prev: revenue −2 … 0%', r => r.lastRevSurprise > -2 && r.lastRevSurprise <= 0],
    ['prev: revenue beat 0 … 2%', r => r.lastRevSurprise > 0 && r.lastRevSurprise < 2], ['prev: revenue beat 2 … 5%', r => r.lastRevSurprise >= 2 && r.lastRevSurprise < 5], ['prev: revenue beat 5%+', r => r.lastRevSurprise >= 5]])
table('THE PREVIOUS EPS BEAT\'S SIZE', [['prev: EPS miss', r => r.lastSurprise <= 0], ['prev: EPS beat 0 … 5%', r => r.lastSurprise > 0 && r.lastSurprise < 5],
    ['prev: EPS beat 5 … 15%', r => r.lastSurprise >= 5 && r.lastSurprise < 15], ['prev: EPS beat 15%+', r => r.lastSurprise >= 15]])
table('THE PREVIOUS REPORT\'S MOVE', [['prev move: down 5%+', r => r.prevReactS <= -5], ['prev move: −5 … 0%', r => r.prevReactS > -5 && r.prevReactS <= 0],
    ['prev move: 0 … +5%', r => r.prevReactS > 0 && r.prevReactS < 5], ['prev move: up 5%+', r => r.prevReactS >= 5]])
table('THE PREVIOUS RESULT × ITS MOVE', [['prev both beat, moved up 5%+', r => pb(r) && r.prevReactS >= 5], ['prev both beat, moved down 5%+', r => pb(r) && r.prevReactS <= -5],
    ['prev both miss, moved up 5%+', r => pm(r) && r.prevReactS >= 5], ['prev both miss, moved down 5%+', r => pm(r) && r.prevReactS <= -5]])
table('THE LAST FOUR (EPS beats)', [['0–1 of 4', r => r.beats4 != null && r.beats4 <= 1], ['2 of 4', r => r.beats4 === 2], ['3 of 4', r => r.beats4 === 3], ['4 of 4', r => r.beats4 === 4]])
fs.writeFileSync('data/lab/range-event-prev.out.txt', out.join('\n') + '\n')
