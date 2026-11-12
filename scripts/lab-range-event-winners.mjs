// THE COMPRESSED GROUP'S TWO WINNING POPULATIONS — Roy, 2026-11-09: "the ones that moved up more than 5% on the report;
// the ones that moved more than 5% in the following month — how much they moved the 5 sessions before the report, and
// until the next report". Reads data/lab/range-event.rows.csv (lab-range-event.mjs). Descriptive.
//
// Compressed = lab-range-event-compressed.mjs (sideways ±5%, range < 0.6× own usual, takeover-pinned out).
//   1. report up 5%+:           close D-1 → close D+1 ≥ +5%
//   2. month after up 5%+:      close D+1 → close D+20, minus SPY, ≥ +5%
// Windows: the 5 sessions before (close D-6 → D-1), the report, the month after, and close D+1 → the close before the
// NEXT report (null when the next report is past the bars' end, 2026-10-26).
//
//   node scripts/lab-range-event-winners.mjs → data/lab/range-event-winners.out.txt
import fs from 'fs'

const [head, ...lines] = fs.readFileSync('data/lab/range-event.rows.csv', 'utf8').trim().split('\n')
const cols = head.split(',')
const rows = lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v === '' ? null : isNaN(+v) ? v : +v])))
const out = [], say = (s = '') => { out.push(s); console.log(s) }
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo) }
const f = (x, w = 8) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`.padStart(w)

const comp = rows.filter(r => r.relWidth != null && Math.abs(r.netChange) <= 5 && r.width >= 6 && r.atrPct >= 0.6 && r.relWidth < 0.6)
const P1 = comp.filter(r => r.react != null && r.react >= 5)
const P2 = comp.filter(r => r.afterX != null && r.afterX >= 5)
const POPS = [['1. report up 5%+', P1], ['2. month after +5% vs SPY', P2], ['   both', P1.filter(r => P2.includes(r))], ['all compressed', comp]]

say(`THE COMPRESSED GROUP'S TWO POPULATIONS — compressed ${comp.length} reports; 1: ${P1.length}; 2: ${P2.length}; in both: ${POPS[2][1].length}`)
say(`(2 raw, not vs SPY: ${comp.filter(r => r.after != null && r.after >= 5).length} reports up 5%+ in the month after)`)
const WINDOWS = [['the 5 sessions BEFORE (D-6 → D-1)', 'pre5'], ['  vs SPY', 'pre5X'], ['THE REPORT (D-1 → D+1)', 'react'],
    ['THE MONTH AFTER (D+1 → D+20)', 'after'], ['  vs SPY', 'afterX'], ['TO THE NEXT REPORT (D+1 → the close before it)', 'toNext'], ['  vs SPY', 'toNextX']]
for (const [t, k] of WINDOWS) {
    say(`\n── ${t}`)
    say(`${'population'.padEnd(28)}${'n'.padStart(5)}${'p10'.padStart(8)}${'p25'.padStart(8)}${'median'.padStart(8)}${'p75'.padStart(8)}${'p90'.padStart(8)}${'up'.padStart(6)}${'≥+5%'.padStart(7)}${'≤−5%'.padStart(7)}`)
    for (const [n, g] of POPS) {
        const xs = g.map(r => r[k]).filter(x => x != null)
        if (!xs.length) { say(`${n.padEnd(28)}${'0'.padStart(5)}`); continue }
        const sh = (p) => `${Math.round((xs.filter(p).length / xs.length) * 100)}%`
        say(`${n.padEnd(28)}${String(xs.length).padStart(5)}${f(q(xs, 0.1))}${f(q(xs, 0.25))}${f(q(xs, 0.5))}${f(q(xs, 0.75))}${f(q(xs, 0.9))}${sh(x => x > 0).padStart(6)}${sh(x => x >= 5).padStart(7)}${sh(x => x <= -5).padStart(7)}`)
    }
}
say(`\n── Sessions from the report to the next one (median): ${POPS.map(([n, g]) => { const v = g.map(r => r.sessionsToNext).filter(x => x != null); return `${n.trim()} ${v.length ? q(v, 0.5).toFixed(0) : '—'}` }).join(' · ')}`)

say(`\n── 1 → 2: of the reports up 5%+, how the month after went (vs SPY)`)
const p1a = P1.filter(r => r.afterX != null)
for (const [lab, p] of [['kept going (+5%+)', x => x >= 5], ['in between', x => x > -5 && x < 5], ['gave it back (−5% or worse)', x => x <= -5]])
    say(`  ${lab.padEnd(30)} ${String(p1a.filter(r => p(r.afterX)).length).padStart(4)}  ${Math.round((p1a.filter(r => p(r.afterX)).length / p1a.length) * 100)}%`)
say(`\n── 2 ← report: of the month-after winners, how the report went`)
for (const [lab, p] of [['report up 5%+', x => x >= 5], ['report −5 … +5%', x => x > -5 && x < 5], ['report down 5%+', x => x <= -5]])
    say(`  ${lab.padEnd(30)} ${String(P2.filter(r => r.react != null && p(r.react)).length).padStart(4)}  ${Math.round((P2.filter(r => r.react != null && p(r.react)).length / P2.length) * 100)}%`)

say(`\n── THE NAMES — 1 (report up 5%+): ${P1.sort((a, b) => b.react - a.react).map(r => `${r.symbol} ${r.report.slice(2)} ${f(r.react, 0).trim()}`).join(', ')}`)
say(`\n── THE NAMES — 2 (month after +5% vs SPY): ${P2.sort((a, b) => b.afterX - a.afterX).map(r => `${r.symbol} ${r.report.slice(2)} ${f(r.afterX, 0).trim()}`).join(', ')}`)
fs.writeFileSync('data/lab/range-event-winners.out.txt', out.join('\n') + '\n')
