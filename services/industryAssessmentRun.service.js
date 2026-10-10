// One Pythia assessment, headless — the admin's "Assess now" (docs/design/pythia-assessment.md, build
// step 1). The weekly change scan that picks WHICH industries to assess is step 6; until then an admin asks
// for one at a time, which is also how the cost of one assessment gets measured (§8, the open cap).
//
//   1. read the sub-industry, its latest screen row (how far it moved) and its standing industry_view
//   2. run the desk on an ASSESSMENT turn; it researches and ends with one <industry_assessment> block
//   3. publish it — checked, the code's facts attached, a revision written, a call logged
//
// The run is made AS the admin who asked (userId), so the model spend lands in the token ledger like any
// desk turn; the cost of THIS run is the ledger's strategy total after minus before, returned beside the
// result. Never throws: the caller is an HTTP handler that reports the outcome.

import { strategyAgentService } from './agents/strategy.agent.service.js'
import { readSubIndustry } from '../api/strategy/industryData.service.js'
import { readTimingRow } from '../api/strategy/screenerData.service.js'
import { industryAssessmentService } from '../api/strategy/industryAssessment.service.js'
import { industryViewService } from '../api/strategy/industryView.service.js'
import { pythiaCallsService } from '../api/strategy/pythiaCalls.service.js'
import { getDb } from '../providers/mongodb.provider.js'
import { COLLECTION as TOKEN_USAGE, monthKey } from './tokenUsage.service.js'
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

async function _strategySpend(userId) {
    if (!userId) return 0
    const db = await getDb()
    const d = await db.collection(TOKEN_USAGE).findOne({ userId, month: monthKey() }, { projection: { byAgent: 1 } })
    return deskSpend(d?.byAgent)
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
    spend: (userId) => _strategySpend(userId),
    settle: () => new Promise(r => setTimeout(r, LEDGER_SETTLE_MS)),
    now: () => new Date().toISOString(),
}
export function _setDeps(d) { Object.assign(_deps, d) }

/** The structural answer to carry beside the verdict, or null while the industry is unanswered. Pure. */
export function structureOf(view) {
    if (!view || view.status !== 'answered') return null
    return { demand: view.demand?.grade ?? null, economics: view.economics?.grade ?? null, cycle: view.cycle?.grade ?? null }
}

/**
 * Assess one sub-industry now → `{ ok, outcome, doc?, call?, cost_usd, detail? }`, outcome one of
 * published | unknown_industry | no_block | refused | error.
 */
export async function assessIndustry(code, { userId = null, deps = _deps, timeoutMs = RUN_TIMEOUT_MS } = {}) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    let before = 0
    try {
        const bundle = await deps.readSub(code)
        if (!bundle) return { ok: false, outcome: 'unknown_industry', cost_usd: 0 }
        const sub = bundle.sub
        const [{ row }, view] = await Promise.all([deps.readRow(sub.code), deps.readView(sub.code)])
        before = await deps.spend(userId)
        const result = await withTimeout(deps.run({
            messages: [], userPrompt: `Assess ${sub.name} (${sub.code}).`,
            chatState: { assess: sub.code }, userId, signal: abort.signal,
            onToken: () => {}, onToolStart: () => {}, onReasoning: () => {}, onPhase: () => {},
        }), timeoutMs, `industry assessment ${sub.code}`)
        await deps.settle()
        const cost = Math.max(0, (await deps.spend(userId)) - before)
        const block = (result?.assessments ?? []).find(b => b.industry === sub.code)
        if (!block) return { ok: false, outcome: 'no_block', cost_usd: cost, detail: (result?.reply ?? '').slice(0, 400) }
        const pub = await deps.publish(block, { sub, row, structure: structureOf(view), recordCall: deps.recordCall, now: deps.now(), source: 'assess_now' })
        if (!pub.ok) return { ok: false, outcome: 'refused', cost_usd: cost, detail: pub.detail }
        logger.info(LOG, 'assessment published', { code: sub.code, verdict: pub.doc.verdict, cost_usd: Number(cost.toFixed(4)), call: pub.call?.logged ?? null })
        return { ok: true, outcome: 'published', doc: pub.doc, call: pub.call, cost_usd: cost }
    } catch (err) {
        logger.warn(LOG, 'assessment failed', { code, error: err.message })
        return { ok: false, outcome: 'error', detail: err.message, cost_usd: Math.max(0, (await deps.spend(userId).catch(() => before)) - before) }
    } finally {
        abort.abort()
        clearTimeout(timer)
    }
}
