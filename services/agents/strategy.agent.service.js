// Pythia — the industry desk's streaming agent (key `strategy`; the brand is UI-only, exactly as
// Prometheus keeps the key `analyst`).
//
// Rebuilt 2026-10-05 (docs/design/pythia-industry-questions.md). It no longer forecasts macro channels or
// publishes active weights: for each GICS sub-industry it answers three structural questions — demand,
// economics, cycle — from the numbers aether-engine measured (api/strategy/industryData.service.js),
// departing from the code's first read only with an argument.
//
// Emits one <industry_view> block per sub-industry it answered. In chat the blocks are DRAFTS returned
// for preview; publishing is a separate act (industryViewService.publishView). The headless review
// (services/industryReview.service.js) publishes what it gets.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { makePhaseCapture, runAgentStream, parseEmitBlocks } from '../agentIO.js'
import { toolsFor } from '../agentTools.registry.js'
import { consultDescription } from '../deepThink.service.js'
import { makePromptLoader, stripEmitTags, makeToolHandler, attachTurnContext, LANGUAGE_RULE, BREVITY_RULE, buildStandingProposalRule, cachedBlock, buildDeskMessages } from '../agentUtils.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { makeRouteCapture, ROUTE_TAGS, buildRouteRule } from '../routing.util.js'
import {
    readSubIndustry, listSubIndustries, readCompanies, coveredSymbols,
    formatSubIndustry, formatCompanies,
} from '../../api/strategy/industryData.service.js'
import { industryViewService } from '../../api/strategy/industryView.service.js'
import { logger } from '../logger.service.js'

const __dirname   = dirname(fileURLToPath(import.meta.url))
const LOG         = '[strategyAgent]'
const PROMPT_PATH = join(__dirname, '../../prompts/strategy_system_prompt.md')
const _systemPrompt = makePromptLoader(PROMPT_PATH, LOG)
const MAX_RECENT_MESSAGES = 8
const MAX_COMPANIES = 60

export const TOOLS = [
    // Order is preserved exactly — prompt caching keys off the array prefix, so new tools are
    // APPENDED, never inserted. `consult` stays last (agentToolsRegistry.test.js).
    ...toolsFor({
        web_search: '',
        list_industries: `Every GICS sub-industry the house measures: code, name, sector, the level it is answered at (its own, or its industry's/group's when it has too few companies), and the code's three first-read grades. Pass \`sector\` to narrow. Use it to find a code or to compare an industry with its neighbours.`,
        get_industry_metrics: `The measured numbers behind the three questions for one sub-industry, from 15 years of SEC filings: DEMAND (chained revenue growth over 10 and 3 years against the whole universe, how steady), ECONOMICS (median ROIC — ROE for financials — against Damodaran's cost of capital, the share of companies clearing it, margin level and stability, top-5 concentration), CYCLE (trailing-12-month margin or ROE in its own 10-year range, the normalised value, whether the industry is cyclical), each with the CODE GRADE you start from, plus any early-review triggers. Also the levels above it for context.`,
        get_industry_companies: `The largest companies classified into a sub-industry (or the level that answers it), with market cap, marking the ones OUR analysts cover. Read it before answering: an industry whose numbers are mostly one company is that company.`,
        get_industry_view: `The house's STANDING answer on a sub-industry — the three grades with their reasoning, reopen conditions, when it is next due, and its revision history. Read it before a review.`,
        consult: consultDescription(`Reach for it when you are about to DEPART from a measured code grade on a large industry, and the argument is close — the override is what the house will read, and it should survive someone attacking it. Not for agreeing with the numbers.`),
    }),
]

/** Resolve the `industry` argument (code or name) the way every tool does. */
const _industry = (input) => (typeof input?.industry === 'string' ? input.industry.trim() : '')

const TOOL_HANDLERS = {
    list_industries: makeToolHandler('list_industries', async (input) => {
        const rows = await listSubIndustries()
        if (!rows.length) return 'No industry measurements yet — the engine has not run.'
        const sector = typeof input?.sector === 'string' && input.sector.trim() ? input.sector.trim().toLowerCase() : null
        return rows.filter(r => !sector || r.sector.toLowerCase() === sector)
            .map(r => `${r.code}  ${r.name} [${r.sector}]${r.answered_at?.level !== 'sub_industry' ? ` → answered at ${r.answered_at.name}` : ''}  demand ${r.grades.demand ?? '-'} · economics ${r.grades.economics ?? '-'} · cycle ${r.grades.cycle ?? '-'}${r.triggers.length ? `  TRIGGERS: ${r.triggers.join(', ')}` : ''}`)
            .join('\n')
    }, (e) => `Could not list industries: ${e.message}`, LOG),
    get_industry_metrics: makeToolHandler('get_industry_metrics', async (input) => formatSubIndustry(await readSubIndustry(_industry(input))),
        (e) => `Could not read the industry metrics: ${e.message}`, LOG),
    get_industry_companies: makeToolHandler('get_industry_companies', async (input) => {
        const b = await readSubIndustry(_industry(input))
        if (!b) return 'Unknown sub-industry — call list_industries for the codes and names.'
        const at = b.sub.answered_at ?? { level: 'sub_industry', code: b.sub.code, name: b.sub.name }
        const limit = Math.min(Math.max(parseInt(input?.limit, 10) || 25, 1), MAX_COMPANIES)
        const [rows, covered] = await Promise.all([readCompanies(at.level, at.code, { limit }), coveredSymbols()])
        return `${at.name} (${at.level.replace('_', ' ')}) — largest ${rows.length}:\n${formatCompanies(rows, covered)}`
    }, (e) => `Could not read the companies: ${e.message}`, LOG),
    get_industry_view: makeToolHandler('get_industry_view', async (input) => {
        const b = await readSubIndustry(_industry(input))
        if (!b) return 'Unknown sub-industry — call list_industries for the codes and names.'
        const v = await industryViewService.getView(b.sub.code)
        return v ? JSON.stringify(_forPrompt(v), null, 2) : `No standing answer on ${b.sub.name} yet.`
    }, (e) => `Could not read the standing view: ${e.message}`, LOG),
}

// The trail is capped in the prompt (the stored trail stays whole) — the recent arc is what a review reads.
const PROMPT_REVISIONS = 5
function _forPrompt({ monitor, revisions, ...rest }) {   // eslint-disable-line no-unused-vars -- monitor dropped on purpose
    return { ...rest, next_review: monitor?.next_check_at ?? null, revisions: (revisions ?? []).slice(0, PROMPT_REVISIONS) }
}

export const strategyAgentService = { chatStream }

async function chatStream({
    messages, userPrompt, chatState = {},
    model: requestedModel, reasoningEffort, userId,
    onToken, onToolStart, onReasoning, onPhase, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
}) {
    const systemPrompt  = _buildSystemPrompt()
    const builtMessages = attachTurnContext(_buildMessages({ messages, userPrompt }), _buildTurnContext(chatState))

    const phase = makePhaseCapture(3, onPhase)
    // Every emit tag is suppressed by default; <industry_view> is parsed from `raw` afterward.
    const route = makeRouteCapture('strategy')
    const tagCaptures = buildTagCaptures({ phase: phase.capture, ...route.captures })

    const raw = await _run({
        log: LOG, requestedModel, userId, messages: builtMessages, systemPrompt,
        tools: TOOLS, toolHandlers: TOOL_HANDLERS,
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning,
        meta: { userPrompt },
    })

    const { reply, views } = _parseStrategyResponse(raw)
    logger.info(LOG, 'chatStream done', { replyLength: reply.length, views: views.length })
    return { reply, phase: phase.get(), views, ...route.result() }
}

// ─── extraction (pure) ────────────────────────────────────────────────────────

/**
 * Every <industry_view> block in the raw output → `{ reply, views }`. A block without an `industry` is
 * dropped — nothing could be published against it. Full checking happens at publish (checkDraft).
 */
export function _parseStrategyResponse(raw) {
    const text  = raw ?? ''
    const reply = stripEmitTags(text, ['industry_view', 'phase', ...ROUTE_TAGS]).trim()
    const views = parseEmitBlocks(text, 'industry_view', LOG)
        .filter(v => v && typeof v === 'object' && !Array.isArray(v) && typeof v.industry === 'string' && v.industry.trim())
        .map(v => ({ ...v, industry: v.industry.trim() }))
    return { reply, views }
}

function _buildSystemPrompt() {
    // The STATIC prompt behind the cache breakpoint, and a small dynamic block.
    const today = new Date().toISOString().slice(0, 10)
    return [
        cachedBlock(_systemPrompt() + buildRouteRule('strategy') + LANGUAGE_RULE + buildStandingProposalRule('industry_view', 'Publish') + BREVITY_RULE),
        { type: 'text', text: `---\nCURRENT DATE: ${today}.` },
    ]
}

/**
 * Per-turn state, attached to the LAST USER MESSAGE: the sub-industry in focus and, on a review, why
 * it was brought back. Null when there is nothing to add.
 */
export function _buildTurnContext(chatState) {
    const focus = typeof chatState?.industry === 'string' && chatState.industry.trim() ? chatState.industry.trim() : null
    if (!focus) return null
    const why = typeof chatState?.review_reason === 'string' && chatState.review_reason.trim()
        ? `\nThis is a REVIEW, brought forward because: ${chatState.review_reason.trim()}.` : ''
    return `IN FOCUS: GICS sub-industry ${focus}.${why}`
}

export function _buildMessages({ messages, userPrompt }) {
    return buildDeskMessages({ messages, userPrompt, max: MAX_RECENT_MESSAGES })
}
