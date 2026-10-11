// RE-ASSESS chosen subjects now (PAID: ~$0.005 each on Luna), booked to the first admin.
//
//   node scripts/reassess.mjs --week            every subject the latest week already assessed, again
//   node scripts/reassess.mjs --unverified      every assessment whose news could not be checked
//   node scripts/reassess.mjs --verdict watch   every assessment with this verdict (add --limit N to chunk)
//   node scripts/reassess.mjs 45301020 th_ai_…  these industries (GICS code) and themes (id)
//   add --limit N to stop after N (a smoke test)
//   add --skip (with --week) to leave out what was already reassessed since the week assessed it
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
const { industryAssessmentService } = await import('../api/strategy/industryAssessment.service.js')
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
        if (args.includes('--skip')) {
            // Already redone: its standing assessment is newer than the week's result for it (a reassess run that
            // was stopped part-way, 2026-10-11) — so a restart pays only for the rest.
            const svc = industryAssessmentService
            const before = subjects.length
            const fresh = await Promise.all(subjects.map(async s => {
                const a = s.kind === 'theme' ? await svc.getThemeAssessment(s.id) : await svc.getAssessment(s.code)
                return a?.assessed_at && s.at && a.assessed_at > s.at
            }))
            subjects = subjects.filter((_, i) => !fresh[i])
            console.log(`--skip: ${before - subjects.length} already reassessed, ${subjects.length} to go`)
        }
    } else if (args.includes('--verdict')) {
        // Every standing assessment with this verdict — e.g. `watch` after the watch / no case split (2026-10-11),
        // when a watch had to name its deciding date. A watch that already names its open question is under the current rule: left out.
        const want = args[args.indexOf('--verdict') + 1]
        const all = await industryAssessmentService.listAssessments()
        subjects = all.filter(a => a.verdict === want && !(want === 'watch' && a.question))
            .map(a => ({ ...a.subject, verdict: a.verdict, trigger: [{ key: 'rules_changed', text: 'the verdict rules changed', detail: null }] }))
    } else if (args.includes('--unverified')) {
        // Every standing assessment whose news could not be checked (cause `unverified`) — after the search is
        // fixed, these are the ones worth paying for again (2026-10-11: 62 of 165, a GNews quota out).
        const all = await industryAssessmentService.listAssessments()
        subjects = all.filter(a => a.cause?.kind === 'unverified').map(a => ({
            ...a.subject, verdict: a.verdict,
            trigger: [{ key: 'news_unchecked', text: 'its news could not be checked last time', detail: null }],
        }))
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
