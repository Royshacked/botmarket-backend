// THE SCREENER LAB (services/screenerLab.service.js) — test one candidate screener rule against the baseline (every
// name, every session), each session counted once, against SPY, after costs.
//
//   node scripts/lab.mjs <hypothesis | all | list> [--universe=screener|smallcap] [--years=N] [--from=YYYY-MM-DD --to=YYYY-MM-DD] [--refresh]
//
// --from/--to: a span of the past instead of the last N years (its own cache, no earnings calendar — a rule that reads
// reports sees none); judged in two halves.
//
// The first run on a universe (or --refresh) reads its daily bars and the earnings calendar (~1,200 reads for the
// screener's, paced at DAILY_SCREENER_RPM) into data/lab/<universe>.json; a hypothesis that needs more (its `extras`:
// the earnings history, insider purchases) reads that once, one read a name. Every run after that is offline.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const args = process.argv.slice(2)
const which = args.find(a => !a.startsWith('--')) ?? 'list'
const { HYPOTHESES, runHypothesis, report } = await import('../services/screenerLab.service.js')
if (which === 'list') { for (const [id, h] of Object.entries(HYPOTHESES)) console.log(`${id}  —  ${h.label} (hold ${h.hold})`); process.exit(0) }
const { loadLabData } = await import('../services/screenerLab.data.js')
const { closeDb } = await import('../providers/mongodb.provider.js')
const t0 = Date.now()
const universe = (args.find(a => a.startsWith('--universe=')) ?? '--universe=screener').split('=')[1]
// One id, `all`, or a prefix ending in * (`runup*`, `gapdown*`).
const chosen = Object.entries(HYPOTHESES).filter(([id]) => which === 'all' || which === id || (which.endsWith('*') && id.startsWith(which.slice(0, -1))))
const extras = [...new Set(chosen.flatMap(([, h]) => h.extras ?? []))]
const years = Number((args.find(a => a.startsWith('--years=')) ?? '--years=1').split('=')[1]) || 1
const arg = (k) => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? null
const window = arg('from') && arg('to') ? { from: arg('from'), to: arg('to') } : null
const data = await loadLabData({ name: universe, years, window, extras: window ? [] : extras, refresh: args.includes('--refresh'),
    onProgress: (label, k, n) => console.log(`  ${label}: ${k} / ${n} (${((Date.now() - t0) / 60000).toFixed(1)} min)`) })
await closeDb()
// Sessions from a few after the calendar's first day (a signal may read the report two sessions back).
// With --years, from the first session a year of bars stands behind (the 200-day, the 52-week high) — the calendar's
// ideas then see only its last year; the run-up ideas read the earnings history and span it all.
const start = data.window ? data.window.from : data.years > 1 ? data.spyDays[260] : data.calendarFrom
const days = data.spyDays.filter(d => d > start).slice(3)
console.log(`${universe}: ${data.names.size} names · ${days[0]} → ${days.at(-1)} (${days.length} sessions) · cache built ${data.builtAt}`)

const f = (v) => v.n ? `${String(v.n).padStart(6)} trades · ${String(v.sessions).padStart(3)} sess · net vs SPY/session ${v.net_session_mean >= 0 ? '+' : ''}${v.net_session_mean}% [${v.ci95?.join(' … ') ?? '—'}] · per trade ${v.net_mean} · median ${v.net_median} · up ${v.up_rate}% · sd ${v.sd}` : '  none'
// `blocks` — the range over non-overlapping blocks of the hold (screenerLab blockRange): the honest one for a multi-day hold.
// With --years, the last year is HELD OUT (2026-10-25): choose on the years before, confirm on the year after.
const splitAt = !data.window && data.years > 1 ? data.calendarFrom : null
const [A, B] = splitAt ? [`before ${splitAt}`, 'held out'] : ['1st ½', '2nd ½']
const show = (label, trades, hold) => {
    const r = report(trades, days, { hold, splitAt })
    const b = r.all.blocks
    console.log(`\n${label}\n  all     ${f(r.all)}\n  blocks  ${b ? `${b.blocks} blocks of ${hold} sessions · ${b.mean >= 0 ? '+' : ''}${b.mean}% [${b.ci95.join(' … ')}]` : '—'}\n  ${A.padEnd(18)} ${f(r.halves.first)}\n  ${B.padEnd(18)} ${f(r.halves.second)}`)
    for (const [k, v] of Object.entries(r.by_tag ?? {})) console.log(`  ${k.padEnd(24)} ${f(v)}\n        ${A.padEnd(18)} ${f(v.first)}\n        ${B.padEnd(18)} ${f(v.second)}`)
}
// --no-baseline: the baseline is every name-session (~900k trades over three years) — skip it where memory is short.
if (!args.includes('--no-baseline')) show('BASELINE — every testable name, every session, hold 5', runHypothesis(null, data, { days }), 5)
for (const [id, h] of chosen) {
    show(`${id} — ${h.label} (hold ${h.hold})`, runHypothesis(h, data, { days }), h.hold)
}
