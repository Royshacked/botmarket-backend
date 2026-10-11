// One Pythia assessment, headless — the admin's "Assess now" (docs/design/pythia-assessment.md, build
// step 1) and the weekly run's (services/pythiaWeekly.service.js, step 6), which passes the change scan's
// reasons as `trigger`: they reach the desk's turn and ride on the published assessment.
//
//   1. read the sub-industry, its latest screen row (how far it moved) and its standing industry_view
//   2. run the desk on an ASSESSMENT turn; it researches and ends with one <industry_assessment> block
//   3. publish it — checked, the code's facts attached, a revision written, a call logged
//
// The run is made AS the admin who asked (userId), so the model spend lands in the token ledger like any
// desk turn; the cost of THIS run is the ledger's strategy total after minus before, returned beside the
// result. Never throws: the caller is an HTTP handler that reports the outcome.

import { strategyAgentService } from './agents/strategy.agent.service.js'
import { readSubIndustry, moneyFacts, universeSymbols, largestCompanies } from '../api/strategy/industryData.service.js'
import { themeService, checkThemeProposal } from '../api/strategy/theme.service.js'
import { readThemeFacts, themeBasket, measuredSubs } from '../api/strategy/themeData.service.js'
import { readTimingRow } from '../api/strategy/screenerData.service.js'
import { industryAssessmentService } from '../api/strategy/industryAssessment.service.js'
import { industryViewService } from '../api/strategy/industryView.service.js'
import { pythiaCallsService } from '../api/strategy/pythiaCalls.service.js'
import { getMonthlyUsage, monthKey } from './tokenUsage.service.js'
import { withTimeout } from './timeout.util.js'
import { logger } from './logger.service.js'

const LOG = '[industryAssessmentRun]'
export const RUN_TIMEOUT_MS = 10 * 60 * 1000

// The ledger books the desk under its log tag ('[strategyAgent]' → 'strategyAgent', agentIO.agentKeyFromLog)
// and its reasoning sidecar under 'consult:strategyAgent' (deepThink.service). Both are this run's spend.
export const LEDGER_AGENT = 'strategyAgent'

/** Pythia's spend this month for a user, desk and sidecar, in USD. Pure over the ledger's byAgent. */
export function deskSpend(byAgent) {
    return Object.entries(byAgent ?? {})
        .filter(([k]) => k === LEDGER_AGENT || k.endsWith(`:${LEDGER_AGENT}`))
        .reduce((sum, [, v]) => sum + (v?.cost ?? 0), 0)
}

/** Pythia's spend for a user in one month — through the token service's own reader, not a second copy. */
async function _strategySpend(userId, month = monthKey()) {
    if (!userId) return 0
    return deskSpend((await getMonthlyUsage(userId, month))?.byAgent)
}

// One run per subject at a time (code review 2026-10-11): a second "Assess now" on the same industry while the
// first is still researching paid for two runs, and each one's cost included the other's spend. The guard is
// per process — this app runs as one.
const _running = new Set()
/** Test seam. */
export function _resetRunning() { _running.clear() }

async function _once(key, fn) {
    if (_running.has(key)) return { ok: false, outcome: 'already_running', cost_usd: 0, detail: 'a run for this is already in progress' }
    _running.add(key)
    try { return await fn() } finally { _running.delete(key) }
}
// Usage is booked fire-and-forget per model call, so the last write can land just after the run returns.
const LEDGER_SETTLE_MS = 2000

const _deps = {
    readSub: (code) => readSubIndustry(code),
    readRow: (code) => readTimingRow(code),
    readView: (code) => industryViewService.getView(code),
    run: (args) => strategyAgentService.chatStream(args),
    publish: (block, opts) => industryAssessmentService.publishAssessment(block, opts),
    recordCall: (doc, opts) => pythiaCallsService.recordCall(doc, opts),
    spend: (userId, month) => _strategySpend(userId, month),
    basket: async (sub) => (await largestCompanies(sub, { limit: 40 })).map(c => c.symbol).filter(Boolean),
    settle: () => new Promise(r => setTimeout(r, LEDGER_SETTLE_MS)),
    now: () => new Date().toISOString(),
    // themes (step 3)
    getTheme: (id) => themeService.getTheme(id),
    themeFacts: (theme) => readThemeFacts(theme),
    themeBasket: (theme) => themeBasket(theme),
    measuredSubs: () => measuredSubs(),
    universeSymbols: () => universeSymbols(),
    proposeTheme: (theme, opts) => themeService.proposeTheme(theme, opts),
}
export function _setDeps(d) { Object.assign(_deps, d) }

/** The structural answer to carry beside the verdict, or null while the industry is unanswered. Pure. */
export function structureOf(view) {
    if (!view || view.status !== 'answered') return null
    return { demand: view.demand?.grade ?? null, economics: view.economics?.grade ?? null, cycle: view.cycle?.grade ?? null }
}

/** The change scan's reasons as the turn's `trigger` line (`{}` without any). Pure. */
export function triggerState(trigger) {
    if (!Array.isArray(trigger) || !trigger.length) return {}
    return { trigger: trigger.map(r => `${r.text ?? r.key}${r.detail ? ` (${r.detail})` : ''}`).join('; ') }
}

/**
 * One headless desk turn, measured → `{ result, cost }`. The ledger is read before and after (with the
 * settle wait, on success and on failure alike) so the cost is THIS run's — approximately: the ledger is
 * per user and desk, so an admin's own Pythia chat during the run lands in it too. A run that crosses into a
 * new month adds the new month's spend. On a throw the error carries `cost`. Shared by every run here.
 */
async function _measuredTurn(deps, { userId, userPrompt, chatState, label, timeoutMs }) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    const month = monthKey()
    const before = await deps.spend(userId, month)
    const cost = async () => {
        await deps.settle()
        const after = await deps.spend(userId, month).catch(() => before)
        const next = monthKey() !== month ? await deps.spend(userId, monthKey()).catch(() => 0) : 0
        return Math.max(0, after - before) + next
    }
    try {
        const result = await withTimeout(deps.run({
            messages: [], userPrompt, chatState, userId, signal: abort.signal,
            onToken: () => {}, onToolStart: () => {}, onReasoning: () => {}, onPhase: () => {},
        }), timeoutMs, label)
        return { result, cost: await cost() }
    } catch (err) {
        err.cost = await cost()
        throw err
    } finally {
        abort.abort()
        clearTimeout(timer)
    }
}

/**
 * Assess one sub-industry now → `{ ok, outcome, doc?, call?, cost_usd, detail? }`, outcome one of
 * published | unknown_industry | no_block | refused | error.
 */
export function assessIndustry(code, opts = {}) {
    return _once(`industry:${code}`, () => _assessIndustry(code, opts))
}

async function _assessIndustry(code, { userId = null, deps = _deps, timeoutMs = RUN_TIMEOUT_MS, source = 'assess_now', trigger = null } = {}) {
    try {
        const bundle = await deps.readSub(code)
        if (!bundle) return { ok: false, outcome: 'unknown_industry', cost_usd: 0 }
        const sub = bundle.sub
        const [{ row }, view] = await Promise.all([deps.readRow(sub.code), deps.readView(sub.code)])
        const { result, cost } = await _measuredTurn(deps, { userId, timeoutMs, userPrompt: `Assess ${sub.name} (${sub.code}).`,
            chatState: { assess: sub.code, ...triggerState(trigger) }, label: `industry assessment ${sub.code}` })
        const block = (result?.assessments ?? []).find(b => b.industry === sub.code)
        if (!block) return { ok: false, outcome: 'no_block', cost_usd: cost, detail: (result?.reply ?? '').slice(0, 400) }
        const basket = await deps.basket(sub)
        const pub = await deps.publish(block, { sub, row, money: moneyFacts(bundle.answering), basket, structure: structureOf(view), recordCall: deps.recordCall, now: deps.now(), source, trigger })
        if (!pub.ok) return { ok: false, outcome: 'refused', cost_usd: cost, detail: pub.detail }
        logger.info(LOG, 'assessment published', { code: sub.code, verdict: pub.doc.verdict, cost_usd: Number(cost.toFixed(4)), call: pub.call?.logged ?? null })
        return { ok: true, outcome: 'published', doc: pub.doc, call: pub.call, cost_usd: cost }
    } catch (err) {
        logger.warn(LOG, 'assessment failed', { code, error: err.message })
        return { ok: false, outcome: 'error', detail: err.message, cost_usd: err.cost ?? 0 }
    }
}

/**
 * Assess one APPROVED theme now (step 3) → the same shape as assessIndustry, outcome one of published |
 * unknown_theme | no_block | refused | error. Its facts are its links' moves and money (themeData), its call
 * graded on the theme's basket.
 */
export function assessTheme(id, opts = {}) {
    return _once(`theme:${id}`, () => _assessTheme(id, opts))
}

async function _assessTheme(id, { userId = null, deps = _deps, timeoutMs = RUN_TIMEOUT_MS, source = 'assess_now', trigger = null } = {}) {
    try {
        const theme = await deps.getTheme(id)
        if (!theme || theme.status !== 'approved') return { ok: false, outcome: 'unknown_theme', cost_usd: 0, detail: theme ? `${theme.name} is ${theme.status}` : `no theme ${id}` }
        const [{ facts }, basket] = await Promise.all([deps.themeFacts(theme), deps.themeBasket(theme)])
        const { result, cost } = await _measuredTurn(deps, { userId, timeoutMs, userPrompt: `Assess the theme ${theme.name} (${theme.id}).`,
            chatState: { assess_theme: theme.id, ...triggerState(trigger) }, label: `theme assessment ${theme.id}` })
        const block = (result?.assessments ?? []).find(b => b.theme === theme.id)
        if (!block) return { ok: false, outcome: 'no_block', cost_usd: cost, detail: (result?.reply ?? '').slice(0, 400) }
        const pub = await deps.publish(block, { theme, facts, basket, recordCall: deps.recordCall, now: deps.now(), source, trigger })
        if (!pub.ok) return { ok: false, outcome: 'refused', cost_usd: cost, detail: pub.detail }
        logger.info(LOG, 'theme assessment published', { id: theme.id, verdict: pub.doc.verdict, cost_usd: Number(cost.toFixed(4)) })
        return { ok: true, outcome: 'published', doc: pub.doc, call: pub.call, cost_usd: cost }
    } catch (err) {
        logger.warn(LOG, 'theme assessment failed', { id, error: err.message })
        return { ok: false, outcome: 'error', detail: err.message, cost_usd: err.cost ?? 0 }
    }
}

export const PROPOSE_MAX = 5

/**
 * Ask Pythia to propose themes (step 3; Pythia proposes, the admin approves) → `{ ok, proposed, refused,
 * skipped, cost_usd }`. Each <theme_proposal> is checked against the measured sub-industries and the
 * universe's tickers; an already-approved theme is skipped, never overwritten.
 */
export function proposeThemes(opts = {}) {
    return _once('propose_themes', () => _proposeThemes(opts))
}

async function _proposeThemes({ userId = null, max = PROPOSE_MAX, deps = _deps, timeoutMs = RUN_TIMEOUT_MS } = {}) {
    const n = Math.min(Math.max(Number(max) || PROPOSE_MAX, 1), 10)
    try {
        const [subs, symbols] = await Promise.all([deps.measuredSubs(), deps.universeSymbols()])
        const { result, cost } = await _measuredTurn(deps, { userId, timeoutMs, userPrompt: `Propose up to ${n} themes.`,
            chatState: { propose_themes: n }, label: 'theme proposals' })
        const proposed = [], refused = [], skipped = []
        for (const block of (result?.theme_proposals ?? []).slice(0, n)) {
            const c = checkThemeProposal(block, subs, symbols)
            if (!c.ok) { refused.push(c.detail); continue }
            const r = await deps.proposeTheme(c.theme, { now: deps.now(), source: 'pythia' })
            if (r.ok) proposed.push({ id: c.theme.id, name: c.theme.name, dropped: c.dropped })
            else skipped.push(r.detail)
        }
        logger.info(LOG, 'themes proposed', { proposed: proposed.length, refused: refused.length, skipped: skipped.length, cost_usd: Number(cost.toFixed(4)) })
        return { ok: true, proposed, refused, skipped, cost_usd: cost }
    } catch (err) {
        logger.warn(LOG, 'theme proposals failed', { error: err.message })
        return { ok: false, outcome: 'error', detail: err.message, cost_usd: err.cost ?? 0 }
    }
}
