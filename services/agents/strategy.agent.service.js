// Pythia — the industry desk's streaming agent (key `strategy`; the brand is UI-only, exactly as
// Prometheus keeps the key `analyst`).
//
// Rebuilt 2026-10-05 (docs/design/pythia-industry-questions.md). It no longer forecasts macro channels or
// publishes active weights: for each GICS sub-industry it answers three structural questions — demand,
// economics, cycle — from the numbers aether-engine measured (api/strategy/industryData.service.js),
// departing from the code's first read only with an argument.
//
// Since 2026-10-10 it also ASSESSES an industry (docs/design/pythia-assessment.md): one
// <industry_assessment> block per assessment turn (chatState.assess), checked and published by
// industryAssessment.service, its price facts attached by code from get_industry_moves' source.
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
    formatSubIndustry, formatCompanies, formatMoney, readMoneyLeaders, formatMoneyLeaders,
} from '../../api/strategy/industryData.service.js'
import { industryViewService } from '../../api/strategy/industryView.service.js'
import { readTimingRow } from '../../api/strategy/screenerData.service.js'
import { formatFacts } from '../../api/strategy/industryAssessment.service.js'
import { themeService } from '../../api/strategy/theme.service.js'
import { readThemeFacts, formatTheme } from '../../api/strategy/themeData.service.js'
import { getEarningsCalendar } from '../../providers/fmp.provider.js'
import { newsService } from '../news.service.js'
import { makeNewsHandlers, formatNewsDigest, capPerSymbol } from '../tools/news.tools.js'
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
        get_industry_metrics: `The measured numbers behind the three questions for one sub-industry, from 15 years of SEC filings: DEMAND (chained revenue growth over 10 and 3 years against the whole universe, how steady), ECONOMICS (the industry's aggregate ROIC — ROE for financials — against Damodaran's cost of capital, with the median company and the share of companies clearing it as breadth, margin level and stability, top-5 concentration), CYCLE (trailing-12-month margin or ROE in its own 10-year range, the normalised value, whether the industry is cyclical), each with the CODE GRADE you start from, plus any early-review triggers. Also the levels above it for context.`,
        get_industry_companies: `The largest companies classified into a sub-industry (or the level that answers it), with market cap, marking the ones OUR analysts cover. Read it before answering: an industry whose numbers are mostly one company is that company.`,
        get_industry_view: `The house's STANDING answer on a sub-industry — the three grades with their reasoning, reopen conditions, when it is next due, and its revision history. Read it before a review.`,
        // The weekly screen's catalyst read (docs/design/industry-screener.md): who reports when. Inserted
        // before `consult`, which stays last.
        get_earnings_calendar: `Upcoming earnings dates between two dates (YYYY-MM-DD, window up to ~3 months), optionally for specific symbols — PASS the industry's leaders and largest companies: a market-wide ask returns only the soonest rows. For the weekly screen's catalyst (Q11): an industry whose largest companies report inside the four-week window has a DATED event.`,
        // The assessment's price input (docs/design/pythia-assessment.md §4.2): facts from code. Appended
        // before `consult`, which stays last.
        get_industry_moves: `How far a sub-industry has MOVED, from the engine's weekly screen: its equal-weight basket's return over 12 and 24 months against SPY, the last 1 and 3 months against the S&P, how stretched it is (distance above its 50-day and that distance's percentile in its own two years), the HYPE FLAG (up 100%+ in two years and 100%+ over the market) with its base rate, and the market regime. Facts to state in an assessment, not to argue with.`,
        // The assessment's NEWS input (§4.1). An industry IS its companies: its largest names' news over the
        // last month, one FMP call through the one news pipe (services/news.service.js, category basket).
        get_industry_news: `The last month's NEWS on a sub-industry's largest companies (up to 15), dated and attributed, at most three per company so one busy name cannot fill it — the first place to look for what is happening to an industry. Headlines are what was WRITTEN, not facts about the industry: weigh them, and say when a story is about one company rather than the group.`,
        // The assessment's MONEY input (§4.3): companies' own money, measured by the engine from cash-flow
        // statements. Funds, insiders and government come later (build step 8).
        get_industry_money: `Where a sub-industry's COMPANIES put their own money, from their cash-flow statements: capex, buybacks, dividends and acquisitions over the last four quarters against the four before (and the change a year earlier, so you see it turning), how many companies raised capex, capex as a share of revenue, the median company's share-count change, and the top spenders. Capex is money committed, not talk — and it is the SUPPLIERS' revenue.`,
        get_capex_leaders: `Where corporate capex is rising and falling most across the whole market, by GICS industry, ranked by the dollar change. Use it to follow the money to where it LANDS: an industry whose customers are spending more is a second-order beneficiary.`,
        // Themes (§3, step 3): the registry, and one theme's value chain with each link's facts.
        list_themes: `The house's THEMES — approved ones (the house list) and proposed ones (awaiting the admin) — each with its id, thesis, search words and its value chain of GICS sub-industries in order (1 direct, 2 suppliers, 3 suppliers' suppliers). Read it before proposing, so you do not propose a theme that exists.`,
        get_theme: `One theme by its id (th_…): its thesis, its value chain link by link with WHY each belongs, and for each link how far it has moved against SPY (12 and 24 months, stretch, hype) and where its companies put money (capex, buybacks). The facts a theme assessment states.`,
        get_news: `Other NEWS: \`headlines\` for the market's front page (macro, rates, geopolitics), \`topic\` to search a theme or an event in words ("data center power", "export controls", "OPEC"), \`companies\` for one ticker. The topic search has a small daily quota and can refuse — if it does, say so and use what you have.`,
        consult: consultDescription(`Reach for it when you are about to DEPART from a measured code grade on a large industry, and the argument is close — the override is what the house will read, and it should survive someone attacking it. Not for agreeing with the numbers.`),
    }),
]

/** Resolve the `industry` argument (code or name) the way every tool does. */
const _industry = (input) => (typeof input?.industry === 'string' ? input.industry.trim() : '')

/** How many of an industry's largest companies its news read covers, and how many headlines reach the model. */
export const INDUSTRY_NEWS_COMPANIES = 15
export const INDUSTRY_NEWS_MAX = 24

/**
 * An industry's news: its largest companies (its own; its answering level's when it has fewer than three),
 * through the one news pipe as a `basket`, spread so no one name fills it. → the digest text.
 */
export async function industryNews(input, deps = { readSub: readSubIndustry, companies: readCompanies, fetch: (o) => newsService.getOrFetch(o) }) {
    const b = await deps.readSub(_industry(input))
    if (!b) return 'Unknown sub-industry — call list_industries for the codes and names.'
    let rows = await deps.companies('sub_industry', b.sub.code, { limit: INDUSTRY_NEWS_COMPANIES })
    const at = b.sub.answered_at
    if (rows.length < 3 && at && at.level !== 'sub_industry') rows = await deps.companies(at.level, at.code, { limit: INDUSTRY_NEWS_COMPANIES })
    const symbols = rows.map(r => r.symbol).filter(Boolean).sort()
    if (!symbols.length) return `No companies classified into ${b.sub.name} — no company news to read.`
    const { articles } = await deps.fetch({ category: 'basket', subject: `gics_${b.sub.code}`, query: symbols.join(',') })
    return formatNewsDigest(capPerSymbol(articles, 3), { subject: `${b.sub.name} — its ${symbols.length} largest companies (${symbols.join(', ')})`, category: 'basket', max: INDUSTRY_NEWS_MAX })
}

const TOOL_HANDLERS = {
    ...makeNewsHandlers(),
    get_industry_news: makeToolHandler('get_industry_news', (input) => industryNews(input),
        (e) => `Could not read the industry's news: ${e.message}`, LOG),
    get_industry_money: makeToolHandler('get_industry_money', async (input) => {
        const b = await readSubIndustry(_industry(input))
        if (!b) return 'Unknown sub-industry — call list_industries for the codes and names.'
        const via = b.answering && b.answering.code !== b.sub.code ? ` (too few companies on its own — measured at ${b.answering.name})` : ''
        return `${b.sub.name} (${b.sub.code})${via}\n${formatMoney(b.answering)}`
    }, (e) => `Could not read the industry's money: ${e.message}`, LOG),
    list_themes: makeToolHandler('list_themes', async () => {
        const themes = await themeService.listThemes({ statuses: ['approved', 'proposed'] })
        if (!themes.length) return 'No themes yet — the house list is empty.'
        return themes.map(t => `${t.id} — ${t.name} [${t.status}]: ${t.thesis}\n  words: ${(t.terms ?? []).join(', ')}\n  chain: ${(t.links ?? []).map(l => `${l.order}:${l.name}`).join(' · ')}`).join('\n')
    }, (e) => `Could not list the themes: ${e.message}`, LOG),
    get_theme: makeToolHandler('get_theme', async (input) => {
        const id = typeof input?.theme === 'string' ? input.theme.trim() : ''
        const theme = id ? await themeService.getTheme(id) : null
        if (!theme) return 'Unknown theme — call list_themes for the ids.'
        const { facts, regime } = await readThemeFacts(theme)
        return formatTheme(theme, facts, regime)
    }, (e) => `Could not read the theme: ${e.message}`, LOG),
    get_capex_leaders: makeToolHandler('get_capex_leaders', async () => formatMoneyLeaders(await readMoneyLeaders()),
        (e) => `Could not read the capex leaders: ${e.message}`, LOG),
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
    get_earnings_calendar: makeToolHandler('get_earnings_calendar',
        ({ from, to, symbols }) => getEarningsCalendar(from, to, Array.isArray(symbols) ? symbols : []),
        (err) => `Could not fetch the earnings calendar: ${err.message}`, LOG),
    get_industry_moves: makeToolHandler('get_industry_moves', async (input) => {
        const b = await readSubIndustry(_industry(input))
        if (!b) return 'Unknown sub-industry — call list_industries for the codes and names.'
        const { row, regime } = await readTimingRow(b.sub.code)
        return `${b.sub.name} (${b.sub.code})\n${formatFacts(row, regime)}`
    }, (e) => `Could not read the industry's moves: ${e.message}`, LOG),
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

    const { reply, views, screens, assessments, theme_proposals } = _parseStrategyResponse(raw)
    logger.info(LOG, 'chatStream done', { replyLength: reply.length, views: views.length, screens: screens.length, assessments: assessments.length, theme_proposals: theme_proposals.length })
    return { reply, phase: phase.get(), views, screens, assessments, theme_proposals, ...route.result() }
}

// ─── extraction (pure) ────────────────────────────────────────────────────────

const _obj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const _txt = (v) => typeof v === 'string' && v.trim()

/**
 * Every <industry_view>, <industry_screen>, <industry_assessment> and <theme_proposal> block in the raw
 * output → `{ reply, views, screens, assessments, theme_proposals }`. A view or screen without an `industry`
 * is dropped, an assessment without an `industry` or a `theme`, a proposal without a `name` — nothing could
 * be published against it. Full checking happens downstream (checkDraft, checkScreen, checkAssessment,
 * checkThemeProposal).
 */
export function _parseStrategyResponse(raw) {
    const text  = raw ?? ''
    const reply = stripEmitTags(text, ['industry_view', 'industry_screen', 'industry_assessment', 'theme_proposal', 'phase', ...ROUTE_TAGS]).trim()
    const blocks = (tag) => parseEmitBlocks(text, tag, LOG).filter(_obj)
    const withIndustry = (tag) => blocks(tag).filter(v => _txt(v.industry)).map(v => ({ ...v, industry: v.industry.trim() }))
    const assessments = blocks('industry_assessment').filter(v => _txt(v.industry) || _txt(v.theme))
        .map(v => (_txt(v.industry) ? { ...v, industry: v.industry.trim() } : { ...v, theme: v.theme.trim() }))
    return {
        reply, views: withIndustry('industry_view'), screens: withIndustry('industry_screen'), assessments,
        theme_proposals: blocks('theme_proposal').filter(v => _txt(v.name)),
    }
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
    if (typeof chatState?.screen === 'string' && chatState.screen.trim()) {
        return `This is the WEEKLY INDUSTRY SCREEN for the engine run of ${chatState.screen.trim()} — follow "The weekly screen" in your instructions. No <industry_view> blocks this turn.`
    }
    if (typeof chatState?.assess_theme === 'string' && /^th_[a-z0-9_]+$/.test(chatState.assess_theme.trim())) {
        return `ASSESSMENT of the theme ${chatState.assess_theme.trim()} — follow "Assessing a theme" in your instructions and end with ONE <industry_assessment> block carrying "theme": "${chatState.assess_theme.trim()}". No <industry_view> blocks this turn.`
    }
    if (chatState?.propose_themes) {
        const n = Math.min(Math.max(Number(chatState.propose_themes) || 5, 1), 10)
        return `PROPOSE THEMES — follow "Proposing themes" in your instructions and end with up to ${n} <theme_proposal> blocks. No other blocks this turn.`
    }
    if (typeof chatState?.assess === 'string' && /^\d{8}$/.test(chatState.assess.trim())) {
        return `ASSESSMENT of GICS sub-industry ${chatState.assess.trim()} — follow "Assessing an industry" in your instructions and end with ONE <industry_assessment> block. No <industry_view> blocks this turn.`
    }
    const focus = typeof chatState?.industry === 'string' && chatState.industry.trim() ? chatState.industry.trim() : null
    if (!focus) return null
    const why = typeof chatState?.review_reason === 'string' && chatState.review_reason.trim()
        ? `\nThis is a REVIEW, brought forward because: ${chatState.review_reason.trim()}.` : ''
    return `IN FOCUS: GICS sub-industry ${focus}.${why}`
}

export function _buildMessages({ messages, userPrompt }) {
    return buildDeskMessages({ messages, userPrompt, max: MAX_RECENT_MESSAGES })
}
