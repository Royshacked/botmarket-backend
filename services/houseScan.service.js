// The HOUSE SCAN, revived on Pythia's verdicts (docs/design/pythia-assessment.md §10, build step 7; Roy 2026-10-11).
// The old scan screened the tilt's overweight sectors and went with the tilt desk (2026-10-05); its input now is
// the week's own judgments: every industry Pythia rated FOR SWING or FOR LONG TERM this week, and every approved
// theme rated so, sends names to Prometheus's research queue (research_queue → coverage), the assessment's thesis
// and risks travelling with each name so Prometheus judges whether it is priced in.
//
// NAMES, BY ARGUS (docs/design/house-research-chain.md steps 3-4; Roy, 2026-10-23 — two filters: Argus gives the
// best 5, Prometheus researches them). For each industry — for a theme, each supplier link (order 2) first, then
// its direct links — code builds the candidate list (houseScan.candidates: every company above a liquidity floor,
// measured; the assessment's named companies first) and Argus picks up to HOUSE_SCAN_PER_INDUSTRY that best carry
// her thesis (houseScan.argus; the code order when his call fails). At most HOUSE_SCAN_WEEKLY_MAX a week, in the
// week's order (biggest change first). Avoid / watch / no case send nothing. The picks are frozen on the
// subject's call (pythiaCalls.attachPicks) and graded against its basket and against the largest names, so the
// choosing earns a record. The research run that follows starts by itself (pythiaWeekly). Never throws: the
// caller is the weekly run.

import { coveredSymbols, readSubIndustry } from '../api/strategy/industryData.service.js'
import { themeService } from '../api/strategy/theme.service.js'
import { industryAssessmentService, longTermYes } from '../api/strategy/industryAssessment.service.js'
import { pythiaCallsService } from '../api/strategy/pythiaCalls.service.js'
import { researchQueueService } from './researchQueue.service.js'
import { industryCandidates } from './houseScan.candidates.js'
import { argusPicks } from './houseScan.argus.js'
import { calcCost, recordUsage } from './tokenUsage.service.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[houseScan]'

const _deps = {
    covered: () => coveredSymbols(),
    sub: async (code) => (await readSubIndustry(code))?.sub ?? null,
    candidates: (sub, book, opts) => industryCandidates(sub, book, opts),
    pick: (input, opts) => argusPicks(input, opts),
    theme: (id) => themeService.getTheme(id),
    assessment: (r) => (r.kind === 'theme' ? industryAssessmentService.getThemeAssessment(r.id) : industryAssessmentService.getAssessment(r.code)),
    enqueue: (row) => researchQueueService.enqueue(row),
    rejected: () => researchQueueService.listQueue({ status: 'rejected', limit: 1000 }),
    // Names already in line (queued or in research, from any desk): the queue would refuse them as duplicates, so
    // they are off the list before Argus spends a slot on one.
    inLine: () => researchQueueService.listQueue({ status: ['queued', 'in_research'], limit: 1000 }),
    attachPicks: (subject, opts) => pythiaCallsService.attachPicks(subject, opts),
    // Argus's calls are the house's spend: booked to the week's ledger as monitor spend, like the research run's.
    costOf: (model, usage) => calcCost(model, usage),
    book: (userId, model, usage) => recordUsage(userId, model, usage, 'houseScanArgus', { monitor: true }),
    perIndustry: () => config.houseScanPerIndustry,
    weeklyMax: () => config.houseScanWeeklyMax,
}
export function _setDeps(d) { Object.assign(_deps, d) }

/** How long a name Prometheus (or the admin) passed on stays out of the house scan (code review 2026-10-11). */
export const REJECTED_DAYS = 56

/** What travels with a name to Prometheus — the verdict that sent it, and why Argus chose it. Pure. */
export function pythiaContext(a, { link = null, why = null, argus = null } = {}) {
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
        // Filter 1's reason (house-research-chain.md step 4): why this name carries her thesis, what would break it.
        ...(argus?.why || argus?.caution ? { argus: { why: argus.why ?? null, caution: argus.caution ?? null, source: argus.source ?? 'argus' } } : {}),
    }
}

/**
 * What the week's results SEND (pythia-two-verdicts.md §2.2): a near-term `swing` to the swing book; a long-term YES made
 * NEW this week (`long_term_new` — no / none → yes) to the long-term book — a monthly review that re-confirms a yes sends
 * nothing again. A row from a week before the split whose verdict was `long_term` still sends it. Pure → `[{ r, book }]`.
 */
export function bookSends(results) {
    const out = []
    for (const r of results ?? []) {
        if (r.outcome !== 'published') continue
        if (r.verdict === 'swing') out.push({ r, book: 'swing' })
        if (r.long_term_new || r.verdict === 'long_term') out.push({ r, book: 'long_term' })
    }
    return out
}

/**
 * The assessment as the BOOK reads it, or null when it no longer speaks for that book. Pure. The long-term view carries
 * the long-term call's thesis and `verdict: 'long_term'`, `horizon: 'years'` — what the candidates, Argus and the queue
 * context (Prometheus's target horizon) read.
 */
export function asBook(a, book) {
    if (!a) return null
    if (book === 'swing') return a.verdict === 'swing' ? a : null
    const lt = book === 'long_term' ? longTermYes(a) : null
    return lt ? { ...a, verdict: 'long_term', horizon: 'years', thesis: lt.thesis ?? a.thesis } : null
}

/**
 * Queue names for this week's FOR SWING / FOR LONG TERM verdicts. `results` are the week's result rows (pythiaWeekly)
 * in the week's order; `bookTo` the ledger Argus's calls book to. →
 * `{ queued: [{ symbol, subject }], considered, skipped_full, picks: [per list], cost_usd }`.
 */
export async function runHouseScan(results, deps = _deps, { alreadyQueued = 0, bookTo = null, now = Date.now() } = {}) {
    const per = Math.max(0, Number(deps.perIndustry()) || 0)
    // The week's ceiling counts what an earlier finish of the same week already queued (a forced rerun).
    const max = Math.max(0, (Number(deps.weeklyMax()) || 0) - (Number(alreadyQueued) || 0))
    const verdicts = bookSends(results)
    const queued = [], lists = []
    let skippedFull = 0, cost = 0
    if (!verdicts.length || !per || !max) return { queued, considered: verdicts.length, skipped_full: 0, picks: lists, cost_usd: 0 }
    const onUsage = (usage, model) => {
        cost += Number(deps.costOf?.(model, usage)) || 0
        if (bookTo) Promise.resolve(deps.book?.(bookTo, model, usage)).catch(() => {})
    }
    try {
        const covered = new Set([...(await deps.covered() ?? [])].map(s => String(s).toUpperCase()))
        // A name passed on recently is not bought again each week: the queue de-duplicates only queued / in research.
        const cutoff = now - REJECTED_DAYS * 86_400_000
        const rejected = new Set(((await deps.rejected?.().catch(() => [])) ?? [])
            .filter(r => Date.parse(r.updated_at ?? r.created_at ?? '') >= cutoff).map(r => String(r.symbol).toUpperCase()))
        const taken = new Set(((await deps.inLine?.().catch(() => [])) ?? []).map(r => String(r.symbol).toUpperCase()))
        for (const { r, book } of verdicts) {
            if (queued.length >= max) { skippedFull++; continue }
            // Re-read: re-assessed since, the verdict that would send it may be gone. Downstream reads the BOOK's view.
            const a = asBook(await deps.assessment(r), book)
            if (!a) continue
            const named = new Map((a.names ?? []).map(x => [String(x.symbol).toUpperCase(), x.why ?? null]))
            // Industries: their own list. Themes: supplier links (order 2) first — the less obvious names — then direct.
            let sources = r.kind === 'theme'
                ? ((await Promise.resolve(deps.theme(r.id)).catch(() => null))?.links ?? []).filter(l => l.order <= 2).sort((x, y) => y.order - x.order).map(l => ({ code: l.code, link: l.name }))
                : [{ code: r.code, link: null }]
            // A theme with no link to read (only order 3, or the theme unreadable) still sends the companies she named —
            // their own list (code review 2026-10-23).
            if (!sources.length && named.size) sources = [{ code: null, link: null }]
            const chosen = [], sourcesUsed = new Set()
            for (const src of sources) {
                if (queued.length >= max) break
                // ONE industry's failure (an engine read, a malformed row) is that industry's: logged, and the week's
                // other verdicts still send names (code review 2026-10-23).
                let rows, pick, total = 0
                try {
                    let listed
                    if (src.code) {
                        const sub = await deps.sub(src.code)
                        if (!sub) continue
                        const list = await deps.candidates(sub, a.verdict, { named: [...named.keys()], covered })
                        listed = list?.rows ?? []
                        total = list?.total ?? 0
                    } else {
                        listed = [...named.keys()].map(symbol => ({ symbol, named: true, covered: covered.has(symbol) }))
                        total = listed.length
                    }
                    // Names already sent or passed on recently are not Argus's to pick again; covered ones stay visible.
                    rows = listed.filter(x => !taken.has(x.symbol) && !rejected.has(x.symbol))
                    const take = Math.min(per, max - queued.length)
                    pick = await deps.pick({ assessment: a, subject: r.name ?? a.subject?.name, link: src.link, rows, max: take }, { onUsage })
                } catch (err) {
                    logger.warn(LOG, 'one list failed — the week goes on', { subject: r.name, code: src.code, error: err.message })
                    continue
                }
                sourcesUsed.add(pick.source)
                lists.push({ subject: r.name ?? a.subject?.name, code: src.code, link: src.link, verdict: a.verdict, source: pick.source,
                    listed: rows.length, total, picks: pick.picks.map(p => p.symbol), passed: pick.passed ?? [],
                    ...(pick.note ? { note: pick.note } : {}), ...(pick.fallback ? { fallback: pick.fallback } : {}) })
                for (const p of pick.picks) {
                    if (queued.length >= max) break
                    const s = p.symbol
                    if (covered.has(s) || taken.has(s) || rejected.has(s)) continue
                    taken.add(s)
                    const q = await deps.enqueue({ symbol: s, source: 'pythia', requestedBy: 'house',
                        context: pythiaContext(a, { link: src.link, why: named.get(s) ?? null, argus: { ...p, source: pick.source } }) })
                    if (q?.ok && !q.duplicate) { queued.push({ symbol: s, subject: r.name }); chosen.push(s) }
                }
            }
            if (chosen.length) {
                const source = sourcesUsed.size === 1 ? [...sourcesUsed][0] : 'mixed'
                await Promise.resolve(deps.attachPicks?.(a.subject, { symbols: chosen, source, covered, book }))
                    .catch(err => logger.warn(LOG, 'picks not attached to the call', { subject: a.subject?.name, error: err.message }))
            }
        }
    } catch (err) {
        logger.warn(LOG, 'house scan stopped', { error: err.message, queued: queued.length })
    }
    const cost_usd = Number(cost.toFixed(4))
    logger.info(LOG, 'house scan', { verdicts: verdicts.length, queued: queued.length, skipped_full: skippedFull, lists: lists.length, cost_usd })
    return { queued, considered: verdicts.length, skipped_full: skippedFull, picks: lists, cost_usd }
}
