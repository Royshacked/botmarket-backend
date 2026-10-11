// RE-ASSESS chosen subjects now (PAID: ~$0.005 each on Luna), booked to the first admin.
//
//   node scripts/reassess.mjs --week            every subject the latest week already assessed, again
//   node scripts/reassess.mjs 45301020 th_ai_…  these industries (GICS code) and themes (id)
//   add --limit N to stop after N (a smoke test)
//
// For when the assessments themselves were wrong — the first live week (2026-10-11) answered 38 of 38 `watch`
// before the verdict rules were added to the prompt. A reassessed subject drops out of the change scan (it now
// carries this run's facts), so this is the only way to redo one before it moves or expires. Each keeps the
// week's trigger, and its result is printed; the week's own document is not changed.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { latestWeek } = await import('../services/pythiaWeekly.service.js')
const { assessIndustry, assessTheme } = await import('../services/industryAssessmentRun.service.js')
const { listAdminUserIds } = await import('../api/user/user.model.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const args = process.argv.slice(2)
const li = args.indexOf('--limit')
const limit = li >= 0 ? Number(args[li + 1]) : Infinity
const named = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit')

try {
    let subjects
    if (args.includes('--week')) {
        const week = await latestWeek()
        const reasons = new Map((week?.flagged ?? []).map(f => [`${f.kind}:${f.code ?? f.id}`, f.reasons]))
        subjects = (week?.results ?? []).filter(r => r.outcome === 'published')
            .map(r => ({ ...r, trigger: reasons.get(`${r.kind}:${r.code ?? r.id}`) ?? null }))
    } else {
        subjects = named.map(s => (s.startsWith('th_') ? { kind: 'theme', id: s, name: s } : { kind: 'industry', code: s, name: s }))
    }
    subjects = subjects.slice(0, limit)
    if (!subjects.length) { console.log('nothing to reassess'); process.exit(0) }
    const userId = (await listAdminUserIds())?.[0] ?? null
    const tally = {}
    let spent = 0
    for (const s of subjects) {
        const opts = { userId, source: 'weekly', trigger: s.trigger ?? null }
        const r = s.kind === 'theme' ? await assessTheme(s.id, opts) : await assessIndustry(s.code, opts)
        spent += r.cost_usd ?? 0
        const v = r.doc?.verdict ?? r.outcome
        tally[v] = (tally[v] ?? 0) + 1
        console.log(`${s.name}: ${s.verdict ?? '—'} → ${v}${r.doc ? ` (${r.doc.confidence}, cause ${r.doc.cause?.kind})` : ` — ${r.detail ?? ''}`}`)
    }
    console.log(JSON.stringify({ reassessed: subjects.length, verdicts: tally, cost_usd: Number(spent.toFixed(4)) }))
} finally {
    await closeDb().catch(() => {})
    process.exit(0)
}
