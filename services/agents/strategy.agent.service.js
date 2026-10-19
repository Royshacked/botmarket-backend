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
import { makePromptLoader, cleanReply, makeToolHandler, attachTurnContext, LANGUAGE_RULE, BREVITY_RULE, buildStandingProposalRule, cachedBlock, normalizeMessages } from '../agentUtils.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { DESKS } from '../desks/registry.js'
import { makeRouteCapture, buildRouteRule } from '../routing.util.js'
import {
    readSubIndustry, listSubIndustries, readCompanies, coveredSymbols,
    formatSubIndustry, formatCompanies, formatMoney, readMoneyLeaders, formatMoneyLeaders, largestCompanies,
    readFlowNodes, formatFlows,
} from '../../api/strategy/industryData.service.js'
import { geopoliticsText } from '../../api/strategy/geopoliticsData.service.js'
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
const MAX_MESSAGES = DESKS.strategy.maxMessages
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
        // What is SCHEDULED for an industry (pythia-assessment.md §4.1): who reports when. Inserted before
        // `consult`, which stays last.
        get_earnings_calendar: `Upcoming earnings dates between two dates (YYYY-MM-DD, window up to ~3 months), optionally for specific symbols — PASS the industry's largest companies: a market-wide ask returns only the soonest rows. An industry whose largest companies report soon has a DATED event; name the date.`,
        // The assessment's price input (docs/design/pythia-assessment.md §4.2): facts from code. Appended
        // before `consult`, which stays last.
        get_industry_moves: `How far a sub-industry has MOVED, from the engine's weekly price run: its equal-weight basket's return over 12 and 24 months against SPY, the last 1 and 3 months against the S&P, how stretched it is (distance above its 50-day and that distance's percentile in its own two years), the HYPE FLAG (up 100%+ in two years and 100%+ over the market) with its base rate, and the market regime. Facts to state in an assessment, not to argue with.`,
        // The assessment's NEWS input (§4.1). An industry IS its companies: its largest names' news over the
        // last month, one FMP call through the one news pipe (services/news.service.js, category basket).
        get_industry_news: `The last month's NEWS on a sub-industry's largest companies (up to 15), dated and attributed, at most three per company so one busy name cannot fill it — the first place to look for what is happening to an industry. Headlines are what was WRITTEN, not facts about the industry: weigh them, and say when a story is about one company rather than the group.`,
        // The assessment's MONEY input (§4.3): companies' own money from cash-flow statements (step 2), and since
        // step 8 the rest — insiders, funds (13F), government contracts (docs/design/pythia-money-flows.md).
        get_industry_money: `Where the money goes in a sub-industry. Its COMPANIES' own money, from their cash-flow statements: capex, buybacks, dividends and acquisitions over the last four quarters against the four before (and the change a year earlier, so you see it turning), how many raised capex, capex as a share of revenue, the median share-count change, the top spenders — capex is money committed, and it is the SUPPLIERS' revenue. Then the rest: INSIDERS buying their own stock (90 days; a cluster is awareness only — it had no tested edge), FUNDS' ownership from 13F against the market and its own range (crowding, never a lead), and federal CONTRACT money on the lines it sells into (the change, not the level). Each comes with how to read it.`,
        get_capex_leaders: `Where corporate capex is rising and falling most across the whole market, by GICS industry, ranked by the dollar change. Use it to follow the money to where it LANDS: an industry whose customers are spending more is a second-order beneficiary.`,
        // Themes (§3, step 3): the registry, and one theme's value chain with each link's facts.
        list_themes: `The house's THEMES — approved ones (the house list) and proposed ones (awaiting the admin) — each with its id, thesis, search words and its value chain of GICS sub-industries in order (1 direct, 2 suppliers, 3 suppliers' suppliers). Read it before proposing, so you do not propose a theme that exists.`,
        get_theme: `One theme by its id (th_…): its thesis, its value chain link by link with WHY each belongs, and for each link how far it has moved against SPY (12 and 24 months, stretch, hype) and where its companies put money (capex, buybacks). The facts a theme assessment states.`,
        get_news: `Other NEWS: \`headlines\` for the market's front page (macro, rates, geopolitics), \`topic\` to search a theme or an event in words ("data center power", "export controls", "OPEC"), \`companies\` for one ticker. The topic search has a small daily quota and can refuse — if it does, say so and use what you have.`,
        // The assessment's GEOPOLITICS input (§4.5, step 4 — docs/design/pythia-geopolitics.md). Appended before
        // `consult`, which stays last.
        get_geopolitics: `Geopolitical risk, MEASURED: the Caldara–Iacoviello index of newspaper attention to geopolitical tension — the world's level against its own ten years, this week's line — and the house's mapped risks (Taiwan Strait, US–China, the Gulf, the Red Sea, Russia–Ukraine, Israel, Korea, Venezuela), each as intense as its hottest party, ELEVATED at two standard deviations. Pass \`industry\` for the risks the map says touch it, which way (hurts / helps) and why. Attention, not impact; the map's directions are hypotheses that failed their history test — a reason to read the news on a risk, never a verdict on its own.`,
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
export async function industryNews(input, deps = { readSub: readSubIndustry, largest: largestCompanies, fetch: (o) => newsService.getOrFetch(o) }) {
    const b = await deps.readSub(_industry(input))
    if (!b) return 'Unknown sub-industry — call list_industries for the codes and names.'
    // The one "largest companies, rolling up when thin" rule (industryData.largestCompanies).
    const rows = await deps.largest(b.sub, { limit: INDUSTRY_NEWS_COMPANIES })
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
        // The rest of the money is read at the sub-industry's OWN node: insiders, funds and contracts are counted per
        // company or per line, so even a thin sub-industry has them. A failed read leaves the companies' money standing.
        const flows = await readFlowNodes(b.sub.code).then(formatFlows).catch(e => `Insiders, funds, government: could not be read (${e.message}).`)
        return `${b.sub.name} (${b.sub.code})${via}\n${formatMoney(b.answering)}\n${flows}`
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
    get_geopolitics: makeToolHandler('get_geopolitics', (input) => geopoliticsText(input, { readSub: readSubIndustry }),
        (e) => `Could not read geopolitical risk: ${e.message}`, LOG),
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
    messages, chatState = {},
    model: requestedModel, reasoningEffort, userId,
    onToken, onToolStart, onReasoning, onPhase, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
}) {
    const systemPrompt  = _buildSystemPrompt()
    const builtMessages = attachTurnContext(normalizeMessages(messages, MAX_MESSAGES), _buildTurnContext(chatState))

    const phase = makePhaseCapture(3, onPhase)
    // Every emit tag is suppressed by default; <industry_view> is parsed from `raw` afterward.
    const route = makeRouteCapture('strategy')
    const tagCaptures = buildTagCaptures({ phase: phase.capture, ...route.captures })

    const raw = await _run({
        log: LOG, requestedModel, userId, messages: builtMessages, systemPrompt,
        tools: TOOLS, toolHandlers: TOOL_HANDLERS,
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning,
    })

    const { reply, views, assessments, theme_proposals } = _parseStrategyResponse(raw)
    logger.info(LOG, 'chatStream done', { replyLength: reply.length, views: views.length, assessments: assessments.length, theme_proposals: theme_proposals.length })
    return { reply, phase: phase.get(), views, assessments, theme_proposals, ...route.result() }
}

// ─── extraction (pure) ────────────────────────────────────────────────────────

const _obj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const _txt = (v) => typeof v === 'string' && v.trim()

/**
 * Every <industry_view>, <industry_assessment> and <theme_proposal> block in the raw output → `{ reply, views,
 * assessments, theme_proposals }`. A view without an `industry` is dropped, an assessment without an `industry`
 * or a `theme`, a proposal without a `name` — nothing could be published against it. Full checking happens
 * downstream (checkDraft, checkAssessment, checkThemeProposal). `industry_screen` (the weekly screen, retired
 * 2026-10-11) is still STRIPPED, so a thread that remembers the old format cannot leak a block into the reply.
 */
export function _parseStrategyResponse(raw) {
    const text  = raw ?? ''
    const reply = cleanReply(text)
    const blocks = (tag) => parseEmitBlocks(text, tag, LOG).filter(_obj)
    const withIndustry = (tag) => blocks(tag).filter(v => _txt(v.industry)).map(v => ({ ...v, industry: v.industry.trim() }))
    const assessments = blocks('industry_assessment').filter(v => _txt(v.industry) || _txt(v.theme))
        .map(v => ({ ...v, ...(_txt(v.industry) ? { industry: v.industry.trim() } : {}), ...(_txt(v.theme) ? { theme: v.theme.trim() } : {}) }))
    return {
        reply, views: withIndustry('industry_view'), assessments,
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

/** Why the weekly change scan brought this assessment, as a line for the turn ('' on an admin's own run). */
function _flagged(chatState) {
    const t = typeof chatState?.trigger === 'string' ? chatState.trigger.replace(/\s+/g, ' ').trim().slice(0, 500) : ''
    // "Whether it changes the verdict" alone read as "keep the verdict cautious": the first live week (2026-10-11)
    // answered 38 of 38 `watch`, one thesis calling itself "a baseline". The verdict is judged on today's evidence.
    return t ? `\nThe weekly change scan flagged it: ${t}. Say what changed, then choose the verdict the evidence supports today ("Choosing the verdict") — not relative to an earlier one, and never as a placeholder.` : ''
}

/**
 * Per-turn state, attached to the LAST USER MESSAGE: the sub-industry in focus and, on a review, why
 * it was brought back; on an assessment, why the weekly scan flagged it. Null when there is nothing to add.
 */
export function _buildTurnContext(chatState) {
    if (typeof chatState?.assess_theme === 'string' && /^th_[a-z0-9_]+$/.test(chatState.assess_theme.trim())) {
        return `ASSESSMENT of the theme ${chatState.assess_theme.trim()} — follow "Assessing a theme" in your instructions and end with ONE <industry_assessment> block carrying "theme": "${chatState.assess_theme.trim()}". No <industry_view> blocks this turn.${_flagged(chatState)}`
    }
    if (chatState?.propose_themes) {
        const n = Math.min(Math.max(Number(chatState.propose_themes) || 5, 1), 10)
        return `PROPOSE THEMES — follow "Proposing themes" in your instructions and end with up to ${n} <theme_proposal> blocks. No other blocks this turn.`
    }
    if (typeof chatState?.assess === 'string' && /^\d{8}$/.test(chatState.assess.trim())) {
        return `ASSESSMENT of GICS sub-industry ${chatState.assess.trim()} — follow "Assessing an industry" in your instructions and end with ONE <industry_assessment> block. No <industry_view> blocks this turn.${_flagged(chatState)}`
    }
    const focus = typeof chatState?.industry === 'string' && chatState.industry.trim() ? chatState.industry.trim() : null
    if (!focus) return null
    const why = typeof chatState?.review_reason === 'string' && chatState.review_reason.trim()
        ? `\nThis is a REVIEW, brought forward because: ${chatState.review_reason.trim()}.` : ''
    return `IN FOCUS: GICS sub-industry ${focus}.${why}`
}

