// THE DRIFT AFTER A REPORT, BY ITS SURPRISE — test E (reportReaction.service collectDrift): bought at the open of the
// second session after the report (the surprise and the reaction both known), held 20 / 40 / 60, net of SPY and the
// cost; by the surprise band, and by the band × the reaction's direction (Roy, 2026-10-26: "events keep affecting prices
// even when far from the event date").
//
//   node scripts/lab-report-drift.mjs
//
// Offline: data/lab/screener-3y.json + its earnings history.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { collectDrift } = await import('../services/reportReaction.service.js')
const { shockTrades } = await import('../services/newsShock.service.js')
const { report, blockRange } = await import('../services/screenerLab.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const FROM = '2023-10-09', SPLIT = '2025-10-23', HOLDS = [20, 40, 60]
const data = await loadLabData({ name: 'screener', years: 3, extras: ['history'] })
await closeDb()
const entryDays = data.spyDays.filter(d => d >= FROM)
const reps = collectDrift(data, { from: FROM })
const s = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x}`)
const counts = {}
for (const r of reps) counts[r.band] = (counts[r.band] ?? 0) + 1
console.log(`${reps.length} reports ${FROM} →, held out from ${SPLIT}: ${JSON.stringify(counts)}`)
function table(title, tagOf) {
    console.log(`\n── ${title} — bought 2 sessions after the report, net vs SPY per session (each session once) [95%] · blocks [95%] · up-share · before / held out`)
    const runs = HOLDS.map(h => { const t = shockTrades(data, reps, h, tagOf); return { h, t, r: report(t, entryDays, { hold: h, splitAt: SPLIT }) } })
    for (const tag of [...new Set(runs.flatMap(({ r }) => Object.keys(r.by_tag ?? {})))].sort()) {
        console.log(`  ${tag}  (${runs[0].r.by_tag?.[tag]?.n ?? 0})`)
        for (const { h, t, r } of runs) {
            const v = r.by_tag?.[tag]
            if (!v?.n) continue
            const b = blockRange(t.filter(x => x.tag === tag), entryDays, h)
            console.log(`     held ${h}: ${s(v.net_session_mean).padStart(6)} [${v.ci95?.map(s).join(' … ') ?? '—'}]  blocks ${b ? `${s(b.mean)} [${b.ci95.map(s).join(' … ')}]` : '—'}  up ${v.up_rate}%   ${s(v.first.net_session_mean)} / ${s(v.second.net_session_mean)}`)
        }
    }
}
table('by the surprise', (r) => r.band)
table('by the surprise and the reaction', (r) => `${r.band.padEnd(8)} · reacted ${r.reacted}`)
process.exit(0)
