// The weekly industry screen, headless — Pythia's catalyst read on top of the engine's numbers
// (docs/design/industry-screener.md §5; Roy's decisions of 2026-10-08).
//
// When the engine has written a new COMPLETE run (industry_timing) that has no screen yet:
//   1. pick the industries the agent must look at — engine timing 6 or 7 (Q11 decides their bucket) and
//      the top two buckets (they need notes) — needsAgent
//   2. hand them to Pythia in batches of BATCH; each answers with <industry_screen> blocks: Q11 under the
//      dated-event rule, the reason, and notes for the top buckets — checkScreen holds a Q11 of 2 to a
//      date inside four weeks
//   3. compute every industry's bucket from the numbers and Q11 (code, not the agent), compare with the
//      previous screen, and publish one document for the run date
//
// A failed batch does not sink the screen: its industries are published with Q11 = 0 and the reason
// "the catalyst review failed this week", and the failure is counted on the document. Never throws: the
// caller is a monitor tick.

import { strategyAgentService } from './agents/strategy.agent.service.js'
import { latestRun, readRun, needsAgent, checkScreen, composeRows, screenPrompt } from '../api/strategy/screenerData.service.js'
import { industryScreenService } from '../api/strategy/industryScreen.service.js'
import { withTimeout } from './timeout.util.js'
import { logger } from './logger.service.js'

const LOG = '[industryScreen]'
export const BATCH = 10
export const BATCH_TIMEOUT_MS = 10 * 60 * 1000

const _deps = {
    latestRun: () => latestRun(),
    readRun:   (asof) => readRun(asof),
    getScreen: (asof) => industryScreenService.getScreen(asof),
    previous:  (asof) => industryScreenService.latestScreen(asof),
    save:      (doc) => industryScreenService.saveScreen(doc),
    run:       (args) => strategyAgentService.chatStream(args),
    now:       () => new Date().toISOString(),
}
export function _setDeps(d) { Object.assign(_deps, d) }

/** One batch through the desk → its checked screens by code, and how many claims were corrected. */
async function _reviewBatch(batch, asof, regime, deps, timeoutMs) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
        const result = await withTimeout(deps.run({
            messages: [], userPrompt: screenPrompt(batch, asof, regime),
            chatState: { screen: asof }, userId: null, signal: abort.signal,
            onToken: () => {}, onToolStart: () => {}, onReasoning: () => {}, onPhase: () => {},
        }), timeoutMs, `industry screen batch ${batch[0]?.code}`)
        const wanted = new Set(batch.map(r => r.code))
        const out = new Map()
        let corrected = 0
        for (const block of result?.screens ?? []) {
            const c = checkScreen(block, asof)
            if (!c.ok) { logger.warn(LOG, 'screen block refused', { detail: c.detail }); continue }
            if (!wanted.has(c.screen.code) || out.has(c.screen.code)) continue
            if (c.screen.q11_corrected) corrected++
            out.set(c.screen.code, c.screen)
        }
        return { out, corrected }
    } finally {
        abort.abort()
        clearTimeout(timer)
    }
}

/**
 * Screen the latest complete engine run, unless it already has a screen (`force` reruns it).
 * → `{ ok, outcome, ... }`, outcome one of published | exists | no_run | error.
 */
export async function runScreen(deps = _deps, { force = false, batchSize = BATCH, timeoutMs = BATCH_TIMEOUT_MS } = {}) {
    try {
        const latest = await deps.latestRun()
        if (!latest) return { ok: false, outcome: 'no_run' }
        const { asof } = latest
        if (!force && await deps.getScreen(asof)) return { ok: true, outcome: 'exists', asof }

        const { rows, regime } = await deps.readRun(asof)
        if (!rows?.length) return { ok: false, outcome: 'no_run', asof }
        const reg = regime?.regime ?? null
        const toReview = rows.filter(r => needsAgent(r, reg))

        const agentByCode = new Map()
        let failedBatches = 0, corrected = 0
        for (let i = 0; i < toReview.length; i += batchSize) {
            const batch = toReview.slice(i, i + batchSize)
            try {
                const r = await _reviewBatch(batch, asof, regime, deps, timeoutMs)
                corrected += r.corrected
                for (const row of batch) {
                    agentByCode.set(row.code, r.out.get(row.code)
                        ?? { code: row.code, q11: 0, q11_reason: 'the review gave no answer for this industry', missing: true })
                }
            } catch (err) {
                failedBatches++
                for (const row of batch) agentByCode.set(row.code, { code: row.code, q11: 0, q11_reason: 'the catalyst review failed this week', missing: true })
                logger.warn(LOG, 'screen batch failed', { first: batch[0]?.code, error: err.message })
            }
        }

        const prev = await deps.previous(asof)
        const prevByCode = new Map((prev?.rows ?? []).map(r => [r.code, r]))
        const out = composeRows(rows, agentByCode, reg, prevByCode)
        const doc = {
            asof, regime: regime ?? null, rows: out, previous_asof: prev?.asof ?? null,
            agent: { asked: toReview.length, answered: [...agentByCode.values()].filter(a => !a.missing).length,
                     failed_batches: failedBatches, corrected_claims: corrected },
            counts: out.reduce((m, r) => ({ ...m, [r.bucket ?? 'unscored']: (m[r.bucket ?? 'unscored'] ?? 0) + 1 }), {}),
            created_at: deps.now(),
        }
        await deps.save(doc)
        logger.info(LOG, 'screen published', { asof, regime: reg, ...doc.agent, counts: doc.counts })
        return { ok: true, outcome: 'published', asof, counts: doc.counts, agent: doc.agent }
    } catch (err) {
        logger.warn(LOG, 'screen failed', { error: err.message })
        return { ok: false, outcome: 'error', error: err.message }
    }
}
