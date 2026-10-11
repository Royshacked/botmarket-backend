// MIGRATION — Pythia's verdict words, interesting_trade → swing, interesting_invest → long_term (Roy, 2026-10-11).
//
//   node scripts/migrate-verdict-words.mjs [--dry-run]
//
// Renames the verdict on the standing assessments (industry_assessment), the logged calls (pythia_calls — so the
// track record groups under one word) and the weeks (pythia_weekly: results, flags, waiting). Revision trails keep
// the words they were written in. Idempotent; the code also reads the old words as the new (LEGACY_VERDICTS), so
// running it late is safe. Run once per database (the laptop's axl_dev; Render's test after the deploy).
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, getDbName, closeDb } = await import('../providers/mongodb.provider.js')
const { LEGACY_VERDICTS } = await import('../api/strategy/industryAssessment.service.js')

const dry = process.argv.includes('--dry-run')
const OLD = Object.keys(LEGACY_VERDICTS)
try {
    const db = await getDb()
    console.log(`db ${getDbName()}${dry ? ' (dry run)' : ''}`)
    for (const name of ['industry_assessment', 'pythia_calls']) {
        for (const [from, to] of Object.entries(LEGACY_VERDICTS)) {
            const n = await db.collection(name).countDocuments({ verdict: from })
            if (!dry && n) await db.collection(name).updateMany({ verdict: from }, { $set: { verdict: to } })
            console.log(`  ${name}: ${from} → ${to}: ${n}`)
        }
    }
    // The weeks: verdicts sit inside arrays, so each touched week is rewritten whole.
    const fix = (v) => LEGACY_VERDICTS[v] ?? v
    let weeks = 0
    for (const w of await db.collection('pythia_weekly').find({ $or: [
        { 'results.verdict': { $in: OLD } }, { 'results.previous_verdict': { $in: OLD } },
        { 'flagged.previous_verdict': { $in: OLD } }, { 'waiting.previous_verdict': { $in: OLD } }] }).toArray()) {
        weeks++
        const set = {
            results: (w.results ?? []).map(r => ({ ...r, verdict: fix(r.verdict), previous_verdict: fix(r.previous_verdict) })),
            flagged: (w.flagged ?? []).map(f => ({ ...f, previous_verdict: fix(f.previous_verdict) })),
            waiting: (w.waiting ?? []).map(f => ({ ...f, previous_verdict: fix(f.previous_verdict) })),
        }
        if (!dry) await db.collection('pythia_weekly').updateOne({ _id: w._id }, { $set: set })
    }
    console.log(`  pythia_weekly: ${weeks} week(s) with old words`)
} finally {
    await closeDb().catch(() => {})
    process.exit(0)
}
