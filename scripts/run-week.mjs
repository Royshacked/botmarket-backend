// PYTHIA'S WEEK from the command line — the change scan, then every flagged assessment (PAID: ~$0.005 each on
// Luna, stopping at PYTHIA_WEEKLY_MAX_USD), booked to the first admin (docs/design/pythia-assessment.md §8).
//
//   node scripts/run-week.mjs [--force]
//
// The same run the monitor and the board's "Run the week" make (services/pythiaWeekly.service.js). Safe beside a
// running server: a week another process is running reads `running` and is not started twice. The board follows
// it through GET /api/strategy/weekly.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { runWeekly } = await import('../services/pythiaWeekly.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const force = process.argv.includes('--force')
const started = Date.now()
try {
    const r = await runWeekly({ force, by: 'script' })
    console.log(JSON.stringify({ ...r, minutes: Math.round((Date.now() - started) / 60000) }))
} finally {
    await closeDb().catch(() => {})
    process.exit(0)
}
