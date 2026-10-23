// PYTHIA'S WEEK from the command line — the change scan, then every flagged assessment (PAID: ~$0.005 each on
// Luna, stopping at PYTHIA_WEEKLY_MAX_USD), booked to the first admin (docs/design/pythia-assessment.md §8).
//
//   node scripts/run-week.mjs [--force] [--limit N]
//
// The same run the monitor and the board's "Run the week" make (services/pythiaWeekly.service.js). Safe beside a
// running server: the week is claimed atomically, and one another process is running is left alone. The board
// follows it through GET /api/strategy/weekly.
//
// --limit N assesses at most N this run and PAUSES the week if more wait; the next run (no --force needed) resumes
// it, inside the same weekly spend ceiling (2026-10-11: on a laptop short of memory, long background runs were
// stopped; short foreground chunks finish). --force reruns a finished week: the scan flags only what is still due.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { runWeekly } = await import('../services/pythiaWeekly.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const force = process.argv.includes('--force')
const li = process.argv.indexOf('--limit')
const limit = li >= 0 ? process.argv[li + 1] : undefined
const started = Date.now()
try {
    const r = await runWeekly({ force, by: 'script', limit })
    console.log(JSON.stringify({ ...r, minutes: Math.round((Date.now() - started) / 60000) }))
    // A finished week starts Prometheus's research on its names (docs/design/house-research-chain.md step 5), in THIS
    // process: wait for it, or the exit below would kill a paid turn mid-way.
    const { researchRunService } = await import('../services/researchRun.service.js')
    while (researchRunService.getRun()?.status === 'running') await new Promise(res => setTimeout(res, 10_000))
    const run = researchRunService.getRun()
    if (run) console.log(JSON.stringify({ research: { status: run.status, covered: run.covered, passed: run.passed, failed: run.failed, cost_usd: run.cost_usd } }))
} finally {
    await closeDb().catch(() => {})
    process.exit(0)
}
