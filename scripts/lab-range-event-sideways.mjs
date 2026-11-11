// SIDEWAYS, BY THE STOCK'S OWN RANGE — Roy, 2026-11-09 ("yes": the follow-up to lab-range-event-profile.mjs). Reads
// data/lab/range-event.rows.csv (lab-range-event.mjs). Descriptive, no trade.
//
// Sideways: the scan day's close within ±5% of the range's first close (`netChange`). Relative width: the 42-session
// range ÷ the stock's own median 42-session range over the year before it (`relWidth`, no look-ahead). Groups:
// compressed < 0.6×, quieter 0.6–0.8×, normal 0.8–1.2×, expanded > 1.2×. Each against every sideways report, and the
// same groups without the sideways rule. `vs own last` = this report's |move| ÷ the stock's |move| at its last report.
//
//   node scripts/lab-range-event-sideways.mjs → data/lab/range-event-sideways.out.txt
import fs from 'fs'

const [head, ...lines] = fs.readFileSync('data/lab/range-event.rows.csv', 'utf8').trim().split('\n')
const cols = head.split(',')
const rows = lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v === '' ? null : isNaN(+v) ? v : +v])))
const out = [], say = (s = '') => { out.push(s); console.log(s) }
const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null)
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo) }
const f = (x, w = 8) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`.padStart(w))
const pc = (n, of, w = 7) => `${of ? Math.round((n / of) * 100) : 0}%`.padStart(w)

const REL = [['compressed <0.6×', 0, 0.6], ['quieter 0.6–0.8×', 0.6, 0.8], ['normal 0.8–1.2×', 0.8, 1.2], ['expanded >1.2×', 1.2, Infinity]]
const withRel = rows.filter(r => r.relWidth != null)
const sideways = withRel.filter(r => Math.abs(r.netChange) <= 5)
const sets = (base) => [...REL.map(([n, lo, hi]) => [n, base.filter(r => r.relWidth >= lo && r.relWidth < hi)]), ['all of these', base]]

say(`SIDEWAYS, BY THE STOCK'S OWN RANGE — ${rows.length} reports, ${withRel.length} with a year of history, ${sideways.length} sideways (±5% over the 2 months)`)
say(`Median relative width: every report ${q(withRel.map(r => r.relWidth), 0.5).toFixed(2)}×, sideways ${q(sideways.map(r => r.relWidth), 0.5).toFixed(2)}×`)

function dist(title, key, groups) {
    say(`\n── ${title}`)
    say(`${'group'.padEnd(18)}${'n'.padStart(6)}${'p10'.padStart(8)}${'p25'.padStart(8)}${'median'.padStart(8)}${'p75'.padStart(8)}${'p90'.padStart(8)}${'mean'.padStart(8)}${'up'.padStart(7)}${'|>10%|'.padStart(8)}`)
    for (const [n, g] of groups) {
        const xs = g.map(r => r[key]).filter(x => x != null)
        if (!xs.length) { say(`${n.padEnd(18)}${'0'.padStart(6)}`); continue }
        say(`${n.padEnd(18)}${String(xs.length).padStart(6)}${f(q(xs, 0.1))}${f(q(xs, 0.25))}${f(q(xs, 0.5))}${f(q(xs, 0.75))}${f(q(xs, 0.9))}${f(mean(xs))}${pc(xs.filter(x => x > 0).length, xs.length)}${pc(xs.filter(x => Math.abs(x) > 10).length, xs.length, 8)}`)
    }
}
function extras(title, groups) {
    say(`\n── ${title}`)
    say(`${'group'.padEnd(18)}${'n'.padStart(6)}${'vs own last'.padStart(13)}${'bigger'.padStart(8)}${'beat EPS'.padStart(10)}${'S&P'.padStart(6)}${'D+20 above'.padStart(12)}${'inside'.padStart(8)}${'below'.padStart(7)}`)
    for (const [n, g] of groups) {
        const ratio = g.filter(r => r.prevReact > 0.25 && r.react != null).map(r => Math.abs(r.react) / r.prevReact)
        const beat = g.filter(r => r.beatThis != null), ex = g.filter(r => r.exitPos)
        say(`${n.padEnd(18)}${String(g.length).padStart(6)}${(ratio.length ? q(ratio, 0.5).toFixed(2) + '×' : '—').padStart(13)}${pc(ratio.filter(x => x > 1).length, ratio.length, 8)}${pc(beat.filter(r => r.beatThis === 1).length, beat.length, 10)}${pc(g.filter(r => r.sp500 === 1).length, g.length, 6)}${pc(ex.filter(r => r.exitPos === 'above').length, ex.length, 12)}${pc(ex.filter(r => r.exitPos === 'inside').length, ex.length, 8)}${pc(ex.filter(r => r.exitPos === 'below').length, ex.length, 7)}`)
    }
}

say(`\n══ SIDEWAYS (±5% over the 2 months), BY RELATIVE WIDTH`)
const sw = sets(sideways)
for (const [t, k] of [['THE REPORT (D-1 → D+1)', 'react'], ['  vs SPY', 'reactX'], ['INTO the report (S → D-1) vs SPY', 'intoX'],
    ['THE MONTH AFTER (D+1 → D+20) vs SPY', 'afterX'], ['ALL (S → D+20) vs SPY', 'allX']]) dist(t, k, sw)
extras('THE REPORT against the stock\'s own last report, and where it stood at D+20', sw)

say(`\n══ THE SAME GROUPS WITHOUT THE SIDEWAYS RULE (every report with a year of history)`)
const al = sets(withRel)
for (const [t, k] of [['THE REPORT (D-1 → D+1)', 'react'], ['ALL (S → D+20) vs SPY', 'allX']]) dist(t, k, al)
extras('THE REPORT against the stock\'s own last report, and where it stood at D+20', al)

say(`\n── SIDEWAYS + COMPRESSED, by where price sat in the range on the scan day`)
const comp = sideways.filter(r => r.relWidth < 0.6)
dist('ALL (S → D+20) vs SPY', 'allX', [['top third', comp.filter(r => r.posInRange >= 2 / 3)], ['middle', comp.filter(r => r.posInRange >= 1 / 3 && r.posInRange < 2 / 3)], ['bottom third', comp.filter(r => r.posInRange < 1 / 3)]])
dist('ALL (S → D+20) vs SPY, by up-day / down-day volume', 'allX', [['up-vol > 1.2', comp.filter(r => r.volRatio > 1.2)], ['0.8–1.2', comp.filter(r => r.volRatio >= 0.8 && r.volRatio <= 1.2)], ['up-vol < 0.8', comp.filter(r => r.volRatio < 0.8)]])

const sectors = new Map()
for (const r of comp) sectors.set(r.sector || '(none)', (sectors.get(r.sector || '(none)') ?? 0) + 1)
say(`\n── SIDEWAYS + COMPRESSED: sectors — ${[...sectors].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', ')}`)
say(`   examples: ${comp.sort((a, b) => a.relWidth - b.relWidth).slice(0, 20).map(r => `${r.symbol} ${r.report} (${r.width.toFixed(0)}% vs usual ${r.ownWidth.toFixed(0)}%, report ${f(r.react, 0).trim()})`).join('; ')}`)
fs.writeFileSync('data/lab/range-event-sideways.out.txt', out.join('\n') + '\n')
