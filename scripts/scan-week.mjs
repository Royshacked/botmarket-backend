// PYTHIA'S CHANGE SCAN, DRY — what this week would assess, without assessing anything (no model, no writes)
// (docs/design/pythia-assessment.md §8, step 6).
//
//   node scripts/scan-week.mjs [cap]
//
// Reads the latest complete engine price run, the metrics' money, the standing assessments and the approved
// themes; prints every flag with its reasons, which ones the cap picks, and how many wait.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { latestRun } = await import('../api/strategy/screenerData.service.js')
const { scanWeek } = await import('../services/pythiaWeekly.service.js')
const { pickForWeek } = await import('../api/strategy/changeScan.service.js')
const { config } = await import('../services/config.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const cap = Number(process.argv[2]) || config.pythiaWeeklyCap
try {
    const latest = await latestRun()
    if (!latest) { console.log('no complete engine run'); process.exit(0) }
    const { flags, scanned, regime } = await scanWeek(latest.asof)
    const { picked, waiting } = pickForWeek(flags, cap)
    console.log(`run ${latest.asof} · regime ${regime ?? '?'} · scanned ${scanned.industries} industries, ${scanned.themes} themes · ${flags.length} flagged · cap ${cap}`)
    const byKey = {}
    for (const f of flags) for (const r of f.reasons) byKey[r.key] = (byKey[r.key] ?? 0) + 1
    console.log('reasons:', Object.entries(byKey).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · '))
    console.log(`\nPICKED (${picked.length}):`)
    for (const f of picked) console.log(`  ${f.kind === 'theme' ? 'THEME ' : ''}${f.name} [score ${f.score}, size ${f.size.toFixed(2)}] — ${f.reasons.map(r => `${r.text}${r.detail ? ` (${r.detail})` : ''}`).join('; ')}`)
    console.log(`\nWAITING: ${waiting.length}`)
} finally {
    await closeDb().catch(() => {})
    process.exit(0)
}
