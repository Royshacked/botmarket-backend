// HTTP handlers for the strategy desk (Pythia, the industry desk — rebuilt 2026-10-05): the streaming
// agent, and the industry views it answers (docs/design/pythia-industry-questions.md).
//
// The views are a BROADCAST — house documents with no owner — so nothing here filters by
// `req.user._id`. The READS are open to every signed-in user; the stream and publishing are admin-only,
// gated per route in strategy.routes. A trader's read carries the answers, not the review machinery.

import { sealing } from '../../services/desks/seal.js'
import { strategyDesk }         from '../../services/desks/strategy.desk.js'
import { industryViewService }  from './industryView.service.js'
import { readSubIndustry, listSubIndustries, moneyFacts, largestCompanies, readFlowNodes, flowFacts } from './industryData.service.js'
import { readGeoFacts } from './geopoliticsData.service.js'
import { notifyIndustryChanged } from '../../services/industryNotify.service.js'
import { pythiaWeeklyService } from '../../services/pythiaWeekly.service.js'
import { industryAssessmentService } from './industryAssessment.service.js'
import { pythiaCallsService } from './pythiaCalls.service.js'
import { forecastMapService } from './forecastMap.service.js'
import { readTimingRow } from './screenerData.service.js'
import { assessIndustry, assessTheme, proposeThemes, structureOf } from '../../services/industryAssessmentRun.service.js'
import { themeService } from './theme.service.js'
import { makeDeskStream }       from '../_shared/deskStream.util.js'
import { sendReason }           from '../_shared/reason.util.js'
import { makeHandle }           from '../_shared/handle.util.js'
import { logger }               from '../../services/logger.service.js'

const LOG = '[strategyCtrl]'
// Every handler below rides makeHandle: the log line and the route to the global handler for the
// throw nobody foresaw. (streamStrategy is streamAgentResponse's, which has its own error path on an
// open SSE stream.)
const _handle = makeHandle(LOG)

// Streaming industry-desk chat → <industry_view> drafts (returned for preview; POST /industries/:code
// publishes one).
// The desk itself is services/desks/strategy.desk.js, shared with the session turn (unified-chat plan phase 4).
export const streamStrategy = makeDeskStream(strategyDesk)


// ─── The industry views (Pythia, rebuilt 2026-10-05) ─────────────────────────

const VIEW_REASONS = {
    bad_draft: [422, 'The view does not hold up — see detail'],
    unknown_industry: [404, 'Unknown GICS sub-industry'],
}

/**
 * Every sub-industry: the house's answer where there is one, beside the engine's measured first read.
 * The two are separate on purpose — a pending industry still shows what was measured.
 */
export const listIndustries = _handle('listIndustries', async (req, res) => {
    const [measured, views] = await Promise.all([listSubIndustries(), industryViewService.listViews()])
    const byCode = new Map(views.map(v => [v.code, v]))
    res.json(measured.map(m => {
        const v = byCode.get(m.code)
        return { ...m, view: v ? { status: v.status, demand: v.demand, economics: v.economics, cycle: v.cycle,
            summary: v.summary, reopen_if: v.reopen_if, next_review: v.monitor?.next_check_at ?? null, updated_at: v.updated_at } : null }
    }))
})

/**
 * One sub-industry: its measurements (and what answers it) plus the house's view. An admin gets the
 * revision trail and the monitor state; a trader gets the answers — the trail carries internal notes
 * ("answer refused at publish — …") and the bookkeeping is the desk's.
 */
export const getIndustry = _handle('getIndustry', async (req, res) => {
    const bundle = await readSubIndustry(req.params.code)
    if (!bundle) return sendReason(res, 'unknown_industry', { overrides: VIEW_REASONS })
    const view = await industryViewService.getView(bundle.sub.code)
    res.json({ ...bundle, view: req.user?.role === 'admin' ? view : forTraders(view) })
})

/** A view without its revision trail and monitor bookkeeping. Pure. */
export function forTraders(view) {
    if (!view) return view
    const { revisions, monitor, ...rest } = view   // eslint-disable-line no-unused-vars -- dropped on purpose
    return { ...rest, next_review: monitor?.next_check_at ?? null }
}

// ─── Pythia's week: the change scan and its assessments (pythia-assessment.md §8) ─

/**
 * The latest week: what the scan flagged and why, what was assessed with its outcome, what waits. `null` (200)
 * before the first one. A trader gets what moved and what was assessed; the spend, the budget and the failure
 * details are the desk's.
 */
export const getWeek = _handle('getWeek', async (req, res) => {
    // `status` is the week's REAL state (pythiaWeekly.weekStatus): a week a dead process left `running` reads
    // `interrupted`, so the board offers to resume it instead of waiting forever.
    const week = await pythiaWeeklyService.latestWeek()
    if (!week) return res.json(pythiaWeeklyService.weeklyRunning() ? { status: 'running' } : null)
    if (req.user?.role === 'admin') return res.json(week)
    const approved = new Set((await themeService.listThemes({ statuses: ['approved'] })).map(t => t.id))
    res.json(weekForTraders(week, approved))
})

/**
 * A week without its spend and bookkeeping (`stopped: 'budget'` says the house's budget ran out), and without
 * themes no longer approved — a retired theme is the admin's, like its verdicts (themeForTraders). Pure.
 */
export function weekForTraders(week, approvedThemes = null) {
    if (!week) return week
    const { cost_usd, max_usd, booked_to, by, cap, stopped, ...rest } = week   // eslint-disable-line no-unused-vars -- dropped on purpose
    const shown = (x) => x?.kind !== 'theme' || !approvedThemes || approvedThemes.has(x.id)
    const list = (k) => (rest[k] ?? []).filter(shown)
    return {
        ...rest,
        results: list('results').map(({ cost_usd: c, detail, ...r }) => r),   // eslint-disable-line no-unused-vars
        ...(rest.flagged ? { flagged: list('flagged') } : {}),
        ...(rest.waiting ? { waiting: list('waiting') } : {}),
        ...(rest.held_back ? { held_back: list('held_back') } : {}),
    }
}

/**
 * Run the week now (admin) on the latest complete engine run — the scan, then up to the cap of assessments.
 * That takes many minutes, so this answers 202 at once and the board reads GET /weekly; `force` runs a
 * finished week again (the scan then flags only what is still due). 409 while a week is running.
 */
export const runWeekNow = _handle('runWeekNow', async (req, res) => {
    const busy = () => res.status(409).json({ ok: false, outcome: 'already_running' })
    if (pythiaWeeklyService.weeklyRunning()) return busy()
    if ((await pythiaWeeklyService.latestWeek())?.status === 'running') return busy()   // another process
    // Checked again after the await: the monitor may have started a week meanwhile. From here to runWeekly's own
    // claim there is no await, so "started" is never answered for a run that did not start (code review 2026-10-11).
    if (pythiaWeeklyService.weeklyRunning()) return busy()
    pythiaWeeklyService.runWeekly({ force: req.body?.force === true, by: req.user?.username ?? null })
        .catch(err => logger.warn(LOG, 'weekly run failed', err.message))
    res.status(202).json({ ok: true, outcome: 'started' })
})

/** Publish a reviewed draft (the chat preview's Publish). Checked against the measured numbers. */
export const publishIndustry = _handle('publishIndustry', async (req, res) => {
    const bundle = await readSubIndustry(req.params.code)
    if (!bundle) return sendReason(res, 'unknown_industry', { overrides: VIEW_REASONS })
    await industryViewService.seedMissing([bundle.sub])
    const r = await industryViewService.publishView(bundle.sub.code, req.body ?? {}, bundle.answering, { note: req.body?.summary ?? null })
    if (!r.ok) return sendReason(res, r.reason, { overrides: VIEW_REASONS, fallback: 500, ...(r.detail ? { extra: { detail: r.detail } } : {}) })
    if (r.changed) notifyIndustryChanged(r.doc, r.changed).catch(err => logger.warn(LOG, 'industry card failed (view is published)', err.message))
    // With a sessionId, Pythia's turns move onto the view they produced (unified-chat §6.2). Never fails the publish.
    await sealing.sealAfterGenerate(req, { kind: 'industry_view', entityIds: [bundle.sub.code], name: bundle.sub.name ?? null })
    res.json(r.doc)
})

// ─── Assessments (docs/design/pythia-assessment.md, build step 1) ───────────

const ASSESS_REASONS = {
    bad_assessment: [422, 'The assessment does not hold up — see detail'],
    unknown_industry: [404, 'Unknown GICS sub-industry'],
    unknown_theme: [404, 'No approved theme by that id'],
}

/**
 * Every published assessment (no trail), and the track record of the calls behind them. Read by everyone.
 * `?view=rows` sends only what a closed row shows (assessment-light-list.md) — an opened row fetches its detail. Without
 * it the full list, as before: an installed app runs its old bundle until it reopens, and that bundle reads the
 * detail off the list.
 */
export const listAssessments = _handle('listAssessments', async (req, res) => {
    const rows = req.query?.view === 'rows'
    const [all, record, approved] = await Promise.all([
        rows ? industryAssessmentService.listAssessmentRows() : industryAssessmentService.listAssessments(),
        pythiaCallsService.trackRecord(), themeService.listThemes({ statuses: ['approved'] })])
    res.json({ assessments: visibleAssessments(all, approved), record })
})

/**
 * Industry assessments, and THEME assessments only while their theme is approved — a retired theme's last
 * verdict must not stay on the board (code review 2026-10-11). Pure.
 */
export function visibleAssessments(all, approvedThemes) {
    const live = new Set((approvedThemes ?? []).map(t => t.id))
    return (all ?? []).filter(a => a.subject?.kind !== 'theme' || live.has(a.subject.id))
}

/** One sub-industry's assessment, or null; the revision trail for admins only (it carries internal notes). */
export const getAssessment = _handle('getAssessment', async (req, res) => {
    const bundle = await readSubIndustry(req.params.code)
    if (!bundle) return sendReason(res, 'unknown_industry', { overrides: ASSESS_REASONS })
    const doc = await industryAssessmentService.getAssessment(bundle.sub.code)
    res.json(req.user?.role === 'admin' ? doc : withoutTrail(doc))
})

/**
 * One THEME's assessment, for an opened row on the board (assessment-light-list.md §2.1) — only while the theme is
 * approved, the board's own rule (visibleAssessments); the revision trail for admins only, as for an industry.
 */
export const getThemeAssessment = _handle('getThemeAssessment', async (req, res) => {
    const theme = await themeService.getTheme(req.params.id)
    if (theme?.status !== 'approved') return sendReason(res, 'unknown_theme', { overrides: ASSESS_REASONS })
    const doc = await industryAssessmentService.getThemeAssessment(theme.id)
    res.json(req.user?.role === 'admin' ? doc : withoutTrail(doc))
})

/** An assessment without its revision trail. Pure. */
export function withoutTrail(doc) {
    if (!doc) return doc ?? null
    const { revisions, ...rest } = doc   // eslint-disable-line no-unused-vars -- dropped on purpose
    return rest
}

/** Publish a reviewed <industry_assessment> draft from the chat preview (admin). */
export const publishAssessment = _handle('publishAssessment', async (req, res) => {
    const bundle = await readSubIndustry(req.params.code)
    if (!bundle) return sendReason(res, 'unknown_industry', { overrides: ASSESS_REASONS })
    const [{ row }, view, companies, flows, geopolitics] = await Promise.all([readTimingRow(bundle.sub.code), industryViewService.getView(bundle.sub.code),
        largestCompanies(bundle.sub, { limit: 40 }), readFlowNodes(bundle.sub.code).then(flowFacts).catch(err => {
            logger.warn('[strategy]', 'flows not read — the assessment freezes none', { code: bundle.sub.code, error: err.message })
            return null
        }), readGeoFacts(bundle.sub.code).catch(err => {
            logger.warn('[strategy]', 'geopolitics not read — the assessment freezes none', { code: bundle.sub.code, error: err.message })
            return null
        })])
    const r = await industryAssessmentService.publishAssessment({ ...(req.body ?? {}), industry: bundle.sub.code },
        { sub: bundle.sub, row, money: moneyFacts(bundle.answering), flows, geopolitics, basket: companies.map(c => c.symbol).filter(Boolean),
            structure: structureOf(view), recordCall: pythiaCallsService.recordCall, source: 'chat' })
    if (!r.ok) return sendReason(res, r.reason, { overrides: ASSESS_REASONS, fallback: 500, ...(r.detail ? { extra: { detail: r.detail } } : {}) })
    res.json({ ...r.doc, call: r.call ?? null })
})

/**
 * Assess one sub-industry now, headless (admin) — several minutes of research. It runs as the admin, so
 * the spend is booked and returned as `cost_usd`: the number the weekly cap is set from.
 */
export const assessNow = _handle('assessNow', async (req, res) => {
    const r = await assessIndustry(req.params.code, { userId: req.user._id })
    res.status(runStatus(r, 'unknown_industry')).json(r)
})

/** The HTTP status of a headless run's outcome. Pure. */
export function runStatus(r, unknown) {
    if (r.ok) return 200
    if (r.outcome === 'already_running') return 409
    if (r.outcome === unknown) return 404
    return r.outcome === 'error' ? 500 : 422
}

// ─── The Forecasts heat map (Roy, 2026-10-14) ─────────────────────────────────
// Read by everyone, like the board: every sub-industry's latest move with Pythia's verdict on top, and an opened
// tile's companies marked where Prometheus covers them (forecastMap.service).

/** The map: `{ asof, tiles, unmapped, covered_at }`. */
export const getForecastMap = _handle('getForecastMap', async (req, res) => {
    res.json(await forecastMapService.readMap())
})

/** One sub-industry's companies, largest first, each marked covered or not. */
export const getIndustryCompanies = _handle('getIndustryCompanies', async (req, res) => {
    const out = await forecastMapService.readCompaniesFor(req.params.code)
    if (!out) return sendReason(res, 'unknown_industry', { overrides: VIEW_REASONS })
    res.json(out)
})

/** The forward log: the latest calls with their grades (everyone). */
export const listCalls = _handle('listCalls', async (req, res) => {
    res.json(await pythiaCallsService.listCalls({ limit: parseInt(req.query?.limit, 10) || 100 }))
})

// ─── Themes (docs/design/pythia-assessment.md §3, step 3) ───────────────────
// Pythia proposes, the admin approves (Roy, 2026-10-10). A trader sees the APPROVED list with each theme's
// assessment; an admin also sees the proposals waiting, and approves, retires, proposes and assesses.

const THEME_REASONS = {
    not_found: [404, 'Unknown theme'],
    bad_status: [422, 'Status must be approved or retired'],
}

/** The themes and, beside each, its assessment (or null). */
export const listThemes = _handle('listThemes', async (req, res) => {
    const admin = req.user?.role === 'admin'
    const themes = await themeService.listThemes({ statuses: admin ? ['approved', 'proposed', 'retired'] : ['approved'] })
    const withAssessments = await Promise.all(themes.map(async t => ({
        ...(admin ? t : themeForTraders(t)),
        assessment: t.status === 'approved' ? withoutTrail(await industryAssessmentService.getThemeAssessment(t.id)) : null,
    })))
    res.json(withAssessments)
})

/** A theme without who proposed, approved or retired it — admins' names are the desk's business. Pure. */
export function themeForTraders(theme) {
    const { proposed_by, approved_by, retired_by, ...rest } = theme   // eslint-disable-line no-unused-vars -- dropped on purpose
    return rest
}

/** Approve or retire a theme (admin). Body `{ status, note? }`. */
export const setThemeStatus = _handle('setThemeStatus', async (req, res) => {
    const r = await themeService.setStatus(req.params.id, req.body?.status, { by: req.user?.username ?? null, note: req.body?.note ?? null })
    if (!r.ok) return sendReason(res, r.reason, { overrides: THEME_REASONS, fallback: 500 })
    res.json(r.doc)
})

/** Ask Pythia to propose themes now (admin) — a few minutes of research, its cost returned. Body `{ max? }`. */
export const proposeThemesNow = _handle('proposeThemesNow', async (req, res) => {
    const r = await proposeThemes({ userId: req.user._id, max: req.body?.max })
    res.status(runStatus(r, null)).json(r)
})

/** Assess one approved theme now (admin), headless, its cost returned. */
export const assessThemeNow = _handle('assessThemeNow', async (req, res) => {
    const r = await assessTheme(req.params.id, { userId: req.user._id })
    res.status(runStatus(r, 'unknown_theme')).json(r)
})
