// PYTHIA'S WEEK from the command line — the change scan, then every flagged assessment (PAID: ~$0.005 each on
// Luna, stopping at PYTHIA_WEEKLY_MAX_USD), booked to the first admin (docs/design/pythia-assessment.md §8).
//
//   node scripts/run-week.mjs [--force] [--limit N]
//
// The same run the monitor and the board's "Run the week" make (services/pythiaWeekly.service.js). Safe beside a
// running server: a week another process is running reads `running` and is not started twice. The board follows
// it through GET /api/strategy/weekly.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { runWeekly, latestWeek, _setDeps } = await import('../services/pythiaWeekly.service.js')
const { config } = await import('../services/config.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const force = process.argv.includes('--force')
// --limit N: assess at most N more this run, then stop — the week stays resumable (2026-10-11: on a laptop
// short of memory, long background runs were stopped; short foreground chunks finish). The week's cap counts
// what it already did, so the cap for this run is that plus N.
const li = process.argv.indexOf('--limit')
const started = Date.now()
try {
    if (li >= 0) {
        const week = await latestWeek()
        const done = week && week.status !== 'done' && !force ? (week.results?.length ?? 0) : 0
        const cap = Math.min(config.pythiaWeeklyCap, done + Number(process.argv[li + 1]))
        _setDeps({ cap: () => cap })
    }
    const r = await runWeekly({ force, by: 'script' })
    console.log(JSON.stringify({ ...r, minutes: Math.round((Date.now() - started) / 60000) }))
} finally {
    await closeDb().catch(() => {})
    process.exit(0)
}
