// THE COMPRESSED GROUP, IN FULL — Roy, 2026-11-09: "concentrate on compressed — distribution of the reaction to the
// report, and of beating SPY in the month after". Reads data/lab/range-event.rows.csv (lab-range-event.mjs).
//
// Compressed: sideways (±5% over the 2 months) and the 42-session range under 0.6× the stock's own usual one
// (lab-range-event-sideways.mjs). Takeover-pinned names out: a range under 6% or a daily ATR under 0.6%.
// Control: the same sideways names at a NORMAL width (0.8–1.2×), same filter.
//
//   node scripts/lab-range-event-compressed.mjs → data/lab/range-event-compressed.out.txt
import fs from 'fs'

const [head, ...lines] = fs.readFileSync('data/lab/range-event.rows.csv', 'utf8').trim().split('\n')
const cols = head.split(',')
const rows = lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v === '' ? null : isNaN(+v) ? v : +v])))
const out = [], say = (s = '') => { out.push(s); console.log(s) }
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo) }
const f = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`

const ok = (r) => r.relWidth != null && Math.abs(r.netChange) <= 5 && r.width >= 6 && r.atrPct >= 0.6
const comp = rows.filter(r => ok(r) && r.relWidth < 0.6)
const ctrl = rows.filter(r => ok(r) && r.relWidth >= 0.8 && r.relWidth < 1.2)
const BINS = [[-Infinity, -20], [-20, -15], [-15, -10], [-10, -5], [-5, -2], [-2, 0], [0, 2], [2, 5], [5, 10], [10, 15], [15, 20], [20, Infinity]]
const binName = ([a, b]) => (a === -Infinity ? `< ${b}%` : b === Infinity ? `> +${a}%` : `${a > 0 ? '+' : ''}${a} … ${b > 0 ? '+' : ''}${b}%`)

function histogram(title, key) {
    const xs = comp.map(r => r[key]).filter(x => x != null), cs = ctrl.map(r => r[key]).filter(x => x != null)
    say(`\n── ${title} — compressed ${xs.length}, control (normal width) ${cs.length}`)
    const scale = 1.5
    for (const bin of BINS) {
        const n = xs.filter(x => x >= bin[0] && x < bin[1]).length, p = (n / xs.length) * 100
        const pcn = (cs.filter(x => x >= bin[0] && x < bin[1]).length / cs.length) * 100
        say(`${binName(bin).padStart(13)} ${String(n).padStart(4)} ${p.toFixed(0).padStart(3)}%  ${'█'.repeat(Math.round(p * scale)).padEnd(40)} control ${pcn.toFixed(0).padStart(3)}%`)
    }
    const line = (lab, v) => `${lab}: p10 ${f(q(v, 0.1))} · p25 ${f(q(v, 0.25))} · median ${f(q(v, 0.5))} · p75 ${f(q(v, 0.75))} · p90 ${f(q(v, 0.9))} · up ${Math.round((v.filter(x => x > 0).length / v.length) * 100)}% · |>10%| ${Math.round((v.filter(x => Math.abs(x) > 10).length / v.length) * 100)}%`
    say(line('  compressed', xs)); say(line('  control   ', cs))
}
say(`THE COMPRESSED GROUP — sideways, range < 0.6× its own usual, takeover-pinned out. ${comp.length} reports, ${new Set(comp.map(r => r.symbol)).size} names, reports ${comp.map(r => r.report).sort()[0]} → ${comp.map(r => r.report).sort().at(-1)}`)
histogram('THE REPORT (close D-1 → close D+1)', 'react')
histogram('THE MONTH AFTER vs SPY (close D+1 → close D+20, minus SPY)', 'afterX')

say(`\n── THE MONTH AFTER vs SPY, by which way the report went`)
for (const [lab, p] of [['report up 5%+', r => r.react >= 5], ['report −5 … +5%', r => r.react > -5 && r.react < 5], ['report down 5%+', r => r.react <= -5]]) {
    for (const [g, set] of [['compressed', comp], ['control', ctrl]]) {
        const v = set.filter(r => r.react != null && r.afterX != null && p(r)).map(r => r.afterX)
        if (v.length) say(`${lab.padEnd(18)} ${g.padEnd(11)} n ${String(v.length).padStart(4)} · p10 ${f(q(v, 0.1)).padStart(7)} · median ${f(q(v, 0.5)).padStart(7)} · p90 ${f(q(v, 0.9)).padStart(7)} · beat SPY ${Math.round((v.filter(x => x > 0).length / v.length) * 100)}%`)
    }
}

say(`\n── BY HALF-YEAR (is the month-after lead in both?)`)
for (const [lab, p] of [['reports to 2026-04-26', r => r.report < '2026-04-27'], ['reports from 2026-04-27', r => r.report >= '2026-04-27']]) {
    for (const [g, set] of [['compressed', comp], ['control', ctrl]]) {
        const v = set.filter(p).map(r => r.afterX).filter(x => x != null)
        say(`${lab.padEnd(24)} ${g.padEnd(11)} n ${String(v.length).padStart(4)} · median ${f(q(v, 0.5)).padStart(7)} · beat SPY ${Math.round((v.filter(x => x > 0).length / v.length) * 100)}%`)
    }
}
fs.writeFileSync('data/lab/range-event-compressed.out.txt', out.join('\n') + '\n')
