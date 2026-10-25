// ARGUS'S JUDGMENT ON PAST WEEKS (services/argusReplay.service.js) — each week's likely movers, the outcome hidden,
// read by Argus on the house model with the headlines up to Monday's open; his picks and avoids scored on the week.
//
//   node scripts/replay-argus-weeks.mjs [weeks=24] [per=10] [--only=YYYY-MM-DD] [--tech]
//
// --tech: each row carries its technicals (techLine) — kept apart, in data/lab/argus-replay-tech.json; the same seeded
// samples, so the two runs differ only by the chart.
//
// Offline bars (data/lab/screener.json); one news read and one model call a week. Resumable: each week's result is kept
// in data/lab/argus-replay.json as it lands, and a week already there is not read again.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const args = process.argv.slice(2)
const [weeks = 24, per = 10] = args.filter(a => !a.startsWith('--')).map(Number)
const only = args.find(a => a.startsWith('--only='))?.split('=')[1] ?? null
const { labWeeks } = await import('../services/screenerLab.service.js')
const { replayArgusWeek, summarizeArgusReplay } = await import('../services/argusReplay.service.js')
const { argusRead } = await import('../services/hotlist.argus.js')
const { fetchStockNews } = await import('../providers/fmp.provider.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const tech = args.includes('--tech')
const FILE = tech ? 'data/lab/argus-replay-tech.json' : 'data/lab/argus-replay.json'
const kept = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { weeks: {} }
const data = await loadLabData({ name: 'screener', extras: ['history'] })
const usage = { input: 0, output: 0, calls: 0 }
const deps = {
    // The news read times out now and then (2026-10-25, the first week): three tries; a week without its news is skipped,
    // never judged blind.
    news: async (symbols, from, to) => {
        for (let k = 1; ; k++) {
            try { return await fetchStockNews({ symbols, from, to, limit: 250 }) } catch (err) {
                if (k >= 3) throw err
                await new Promise(r => setTimeout(r, 10_000 * k))
            }
        }
    },
    read: (board) => argusRead(board, { onUsage: (u) => { usage.calls++; usage.input += u?.input_tokens ?? u?.prompt_tokens ?? 0; usage.output += u?.output_tokens ?? u?.completion_tokens ?? 0 } }),
}
for (const ds of labWeeks(data.spyDays, weeks)) {
    if (only && ds[0] !== only) continue
    if (kept.weeks[ds[0]]) continue
    let w
    try { w = await replayArgusWeek(data, ds, { per, tech, deps }) } catch (err) { console.log(`${ds[0]}: skipped — ${err.message}`); continue }
    if (!w) { console.log(`${ds[0]}: no read`); continue }
    kept.weeks[ds[0]] = w
    fs.writeFileSync(FILE, JSON.stringify(kept, null, 1))
    const p = w.picks, a = w.avoid
    console.log(`${ds[0]}  picks ${p.n} (${p.up} up · ${p.down} down) net ${p.net_mean}  ·  avoid ${a.n} (${a.up} up · ${a.down} down) net ${a.net_mean}  ·  all ${w.all.net_mean}  [${w.model}]`)
}
await closeDb()
const s = summarizeArgusReplay(Object.values(kept.weeks))
console.log(`\n${Object.keys(kept.weeks).length} weeks · tokens in ${usage.input} out ${usage.output} over ${usage.calls} calls this run`)
for (const [k, v] of Object.entries(s)) console.log(`  ${k.padEnd(6)} ${String(v.names).padStart(4)} names · up hard ${v.up} vs down hard ${v.down} (${v.up_share}% up) · net/name ${v.net_mean} · per week ${v.week_mean} [${v.ci95?.join(' … ') ?? '—'}]`)
process.exit(0)
