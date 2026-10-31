// MIGRATION — Pythia's two verdicts (docs/design/pythia-two-verdicts.md §2.3; Roy, 2026-10-31: "Industry can hold two
// verdicts").
//
//   node scripts/migrate-pythia-long-term.mjs [--dry-run]
//
// A standing assessment whose VERDICT is long term (or the older interesting_invest) becomes a long-term YES — its thesis
// kept, reviewed when it was assessed — with the near term `no_case`, expired now so the next weekly run (or the due pass)
// answers both. Every other assessment is left as it is: it has no long-term call yet, and the change scan flags it
// (`long_term_due`) — the first monthly review answers it. Logged calls keep `long_term` (that is the long-term call's
// word now). Idempotent; the code also reads an unmigrated document as a yes (longTermOf), so running it late is safe.
// Run once per database (the laptop's axl_dev; Render's test after the deploy).
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, getDbName, closeDb } = await import('../providers/mongodb.provider.js')
const { COLLECTION, LONG_TERM_REVIEW_DAYS } = await import('../api/strategy/industryAssessment.service.js')

const dry = process.argv.includes('--dry-run')
const now = new Date().toISOString()
const plus = (iso, days) => new Date(Date.parse(iso) + days * 86_400_000).toISOString()
try {
    const db = await getDb()
    console.log(`db ${getDbName()}${dry ? ' (dry run)' : ''}`)
    const docs = await db.collection(COLLECTION).find({ verdict: { $in: ['long_term', 'interesting_invest'] }, 'long_term.call': { $exists: false } }).toArray()
    for (const d of docs) {
        const reviewed = d.assessed_at ?? now
        const long_term = { call: 'yes', thesis: d.thesis ?? null, why: null, override_reason: null, hype: d.moved?.hype === true,
            reviewed_at: reviewed, expires_at: plus(reviewed, LONG_TERM_REVIEW_DAYS), previous: null, migrated: now }
        console.log(`  ${d.subject?.name ?? d.id}: verdict ${d.verdict} → long term yes (reviewed ${String(reviewed).slice(0, 10)}), near term no_case, due now`)
        if (dry) continue
        await db.collection(COLLECTION).updateOne({ id: d.id }, {
            $set: { long_term, verdict: 'no_case', expires_at: now, updated_at: now },
            $push: { revisions: { kind: 'migration', at: now, note: 'two verdicts: the long-term verdict became the long-term call; the near term is due', changed: { verdict: { from: d.verdict, to: 'no_case' }, long_term: { from: null, to: 'yes' } } } },
        })
    }
    console.log(`  ${docs.length} assessment(s) ${dry ? 'would be' : ''} split`)
} finally {
    await closeDb().catch(() => {})
    process.exit(0)
}
