// The HOUSE SCAN, revived on Pythia's verdicts (docs/design/pythia-assessment.md §10, build step 7; Roy 2026-10-11).
// The old scan screened the tilt's overweight sectors and went with the tilt desk (2026-10-05); its input now is
// the week's own judgments: every industry Pythia rated FOR SWING or FOR LONG TERM this week, and every approved
// theme rated so, sends names to Prometheus's research queue (research_queue → coverage), the assessment's thesis
// and risks travelling with each name so Prometheus judges whether it is priced in.
//
// NAMES, by code (Roy: "1 for now" — Argus choosing them is open item 3): the industry's largest companies we do not
// already cover, HOUSE_SCAN_PER_INDUSTRY of them; for a theme, its supplier links (order 2) first — the less obvious
// names the crowd misses — then its direct links, the same count per link. At most HOUSE_SCAN_WEEKLY_MAX a week,
// in the week's order (biggest change first). Avoid / watch / no case send nothing. Queuing is free; the research
// run that follows is the admin's (POST /api/analyst/research-queue/run). Never throws: the caller is the weekly run.

import { largestCompanies, coveredSymbols, readSubIndustry } from '../api/strategy/industryData.service.js'
import { themeService } from '../api/strategy/theme.service.js'
import { industryAssessmentService, BOOKS } from '../api/strategy/industryAssessment.service.js'
import { researchQueueService } from './researchQueue.service.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[houseScan]'

const _deps = {
    covered: () => coveredSymbols(),
    largest: async (code, limit) => {
        const b = await readSubIndustry(code)
        return b ? (await largestCompanies(b.sub, { limit })).map(c => c.symbol).filter(Boolean) : []
    },
    theme: (id) => themeService.getTheme(id),
    assessment: (r) => (r.kind === 'theme' ? industryAssessmentService.getThemeAssessment(r.id) : industryAssessmentService.getAssessment(r.code)),
    enqueue: (row) => researchQueueService.enqueue(row),
    rejected: () => researchQueueService.listQueue({ status: 'rejected', limit: 1000 }),
    perIndustry: () => config.houseScanPerIndustry,
    weeklyMax: () => config.houseScanWeeklyMax,
}
export function _setDeps(d) { Object.assign(_deps, d) }

/** How long a name Prometheus (or the admin) passed on stays out of the house scan (code review 2026-10-11). */
export const REJECTED_DAYS = 56

/** What travels with a name to Prometheus — the verdict that sent it. Pure. */
export function pythiaContext(a, { link = null, why = null } = {}) {
    const book = { swing: 'for swing', long_term: 'for long term' }[a.verdict] ?? a.verdict
    return {
        pythia: true,
        // The queue's title for the row (toWatchRow reads `reason`).
        reason: `Pythia: ${a.subject?.name ?? 'industry'} ${book}`,
        subject: a.subject?.name ?? null, kind: a.subject?.kind ?? 'industry', link,
        verdict: a.verdict, horizon: a.horizon ?? null,
        thesis: String(a.thesis ?? '').slice(0, 500) || null,
        risks: (a.risks ?? []).slice(0, 3),
        assessment_id: a.id ?? null,
        // A company the assessment NAMED: what pointed at it (pythia-names.md) — Prometheus's opening reads it.
        ...(why ? { named_why: String(why).slice(0, 200) } : {}),
    }
}

/**
 * Queue names for this week's FOR SWING / FOR LONG TERM verdicts. `results` are the week's result rows (pythiaWeekly)
 * in the week's order. → `{ queued: [{ symbol, subject }], considered, skipped_full }`.
 */
export async function runHouseScan(results, deps = _deps, { alreadyQueued = 0, now = Date.now() } = {}) {
    const per = Math.max(0, Number(deps.perIndustry()) || 0)
    // The week's ceiling counts what an earlier finish of the same week already queued (a forced rerun).
    const max = Math.max(0, (Number(deps.weeklyMax()) || 0) - (Number(alreadyQueued) || 0))
    const picks = (results ?? []).filter(r => r.outcome === 'published' && BOOKS.includes(r.verdict))
    const queued = []
    if (!picks.length || !per || !max) return { queued, considered: picks.length, skipped_full: 0 }
    let skippedFull = 0
    try {
        const covered = new Set([...(await deps.covered() ?? [])].map(s => String(s).toUpperCase()))
        // A name passed on recently is not bought again each week: the queue de-duplicates only queued / in research.
        const cutoff = now - REJECTED_DAYS * 86_400_000
        const rejected = new Set(((await deps.rejected?.().catch(() => [])) ?? [])
            .filter(r => Date.parse(r.updated_at ?? r.created_at ?? '') >= cutoff).map(r => String(r.symbol).toUpperCase()))
        const taken = new Set()
        for (const r of picks) {
            if (queued.length >= max) { skippedFull++; continue }
            const a = await deps.assessment(r)
            if (!a || !BOOKS.includes(a.verdict)) continue      // re-assessed since: the verdict that would send it is gone
            // The companies the assessment NAMES go first (pythia-names.md; Roy, 2026-10-13), with why on the row; then
            // the largest. Industries: the names and the sub-industry's largest share `per`. Themes: the names take `per`
            // of their own, then supplier links first, then direct — `per` from each link.
            const named = (a.names ?? []).map(x => ({ symbol: x.symbol, why: x.why }))
            const links = r.kind === 'theme'
                ? ((await deps.theme(r.id))?.links ?? []).filter(l => l.order <= 2).sort((x, y) => y.order - x.order).map(l => ({ code: l.code, link: l.name }))
                : [{ code: r.code, link: null, named }]
            const sources = r.kind === 'theme' && named.length ? [{ code: null, link: null, named }, ...links] : links
            for (const src of sources) {
                let n = 0
                const pool = [...(src.named ?? []), ...(src.code ? (await deps.largest(src.code, per * 4)).map(symbol => ({ symbol })) : [])]
                for (const cand of pool) {
                    if (n >= per || queued.length >= max) break
                    const s = String(cand.symbol).toUpperCase()
                    if (covered.has(s) || taken.has(s) || rejected.has(s)) continue
                    const q = await deps.enqueue({ symbol: s, source: 'pythia', requestedBy: 'house', context: pythiaContext(a, { link: src.link, why: cand.why ?? null }) })
                    taken.add(s)
                    if (q?.ok && !q.duplicate) { queued.push({ symbol: s, subject: r.name }); n++ }
                }
            }
        }
    } catch (err) {
        logger.warn(LOG, 'house scan stopped', { error: err.message, queued: queued.length })
    }
    logger.info(LOG, 'house scan', { verdicts: picks.length, queued: queued.length, skipped_full: skippedFull })
    return { queued, considered: picks.length, skipped_full: skippedFull }
}
