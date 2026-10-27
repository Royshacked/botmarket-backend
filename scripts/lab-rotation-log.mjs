// THE ROTATION'S FORWARD LOG (services/rotationLog.service.js) — run once a month, after the month's first sessions:
//
//   node scripts/lab-sp500-universe.mjs                                   (the index's changes since)
//   node --max-old-space-size=6000 scripts/lab-rotation.mjs --universe=sp500 --library=m --to=<today> --refresh
//   node scripts/lab-rotation-log.mjs                                     (→ docs/design/rotation-log.csv, committed)
//
// The refresh writes a new cache, data/lab/sp500-2019-01-02_<today>.json (~130 MB) — delete the month before's by hand.
// `--check`: the map over the held-out span of §31 (2024-01 → 2026-09), to compare with scripts/lab-rotation.py.
import fs from 'fs'
import { monthly, mergeLog, picksFor, score, LOG_HEAD, WATCH } from '../services/rotationLog.service.js'

const LOG = 'docs/design/rotation-log.csv'
const csv = (file) => {
    const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
    const cols = head.split(',')
    return lines.filter(Boolean).map(l => Object.fromEntries(l.split(',').map((v, k) => [cols[k], v])))
}
const daily = csv('data/lab/rotation-daily-sp500-m.csv').map(r => ({ rule: r.rule, day: r.day, ret: Number(r.ret) }))
const view = monthly(daily, csv('data/lab/rotation-regimes.csv'))
const f = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(7)
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length
console.log(`books through ${view.lastDay} · ${view.rules.length} rules`)

if (process.argv.includes('--check')) {
    const held = view.months.filter(m => m >= '2024-01' && m <= '2026-09')
    const of = (m, p) => (p ? mean(p.map(r => view.sum(m, r))) : view.all(m))
    console.log(`held out ${held.length} months: fixed ${f(mean(held.map(m => of(m, picksFor(view, m).fixed))))}  expanding ${f(mean(held.map(m => of(m, picksFor(view, m).expanding))))}  ALL ${f(mean(held.map(view.all)))}`)
    process.exit(0)
}

const existing = fs.existsSync(LOG) ? csv(LOG) : []
const { rows, changed } = mergeLog(view, existing, { today: new Date().toISOString().slice(0, 10) })
fs.writeFileSync(LOG, [LOG_HEAD.join(','), ...rows.map(r => LOG_HEAD.map(c => r[c]).join(','))].join('\r\n') + '\r\n')
console.log(`→ ${LOG} · ${rows.length} months`)
for (const m of changed) console.log(`  ! ${m}: a fresh run would pick differently (the data was revised) — the logged picks are kept`)
for (const r of rows) {
    console.log(`  ${r.month} ${r.state.padEnd(24)} fixed ${r.fixed_picks}${r.fixed ? ` ${r.fixed}%` : ''} · expanding ${r.expanding_picks}${r.expanding ? ` ${r.expanding}%` : ''}` +
        (r.all ? ` · ALL ${r.all}% · ${WATCH.map(w => `${w} ${r[w]}%`).join(' · ')}` : ' · in progress'))
}
const s = score(rows)
if (s) console.log(`\nso far, ${s.months} months vs SPY: fixed ${f(s.fixed)} (up ${s.fixedUp}, over ALL ${s.fixedOverAll}) · expanding ${f(s.expanding)} · ALL ${f(s.all)} · ${WATCH.map(w => `${w} ${f(s[w])}`).join(' · ')}`)
if (!rows.length) console.log(`no month from the log's start yet — the first row comes once the data has a session in it`)
