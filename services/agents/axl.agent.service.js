import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { logger }         from '../logger.service.js'
import { normalizeMessages, makePromptLoader, cleanReply, buildAudienceSection, attachTurnContext, LANGUAGE_RULE, VOICE_RULE, BREVITY_RULE, VENUE_RULE, cachedBlock } from '../agentUtils.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { makeSuggestionCapture } from '../suggestions.service.js'
import { DESKS } from '../desks/registry.js'
import { makeRouteCapture, ADMIN_DESKS } from '../routing.util.js'
import { runAgentStream } from '../agentIO.js'
import { toolsFor } from '../agentTools.registry.js'
import { makeTradingContextHandlers, buildVenueSection, TRADING_CONTEXT_TOOL_SPEC } from '../tools/tradingContext.tools.js'
import { makeMarketHoursHandlers, MARKET_HOURS_TOOL_SPEC } from '../tools/marketHours.tools.js'
import { makeUserDataHandlers, USER_DATA_TOOL_SPEC } from '../tools/userData.tools.js'
import { makeConceptHandlers, CONCEPT_TOOL_SPEC } from '../tools/concepts.tools.js'
import { makeExperienceHandlers, EXPERIENCE_TOOL_SPEC } from '../tools/experience.tools.js'
import { makeMarketBriefHandlers, MARKET_BRIEF_TOOL_SPEC } from '../tools/marketBrief.tools.js'
import { makeIndustryViewsHandlers, INDUSTRY_VIEWS_TOOL_SPEC } from '../tools/industryViews.tools.js'
import { makeNewsHandlers, NEWS_TOOL_SPEC } from '../tools/news.tools.js'
import { makeHotlistHandlers, HOTLIST_TOOL_SPEC } from '../tools/hotlist.tools.js'
import { makeCompanyViewHandlers, COMPANY_VIEW_TOOL_SPEC } from '../tools/companyView.tools.js'
import { makeIndustryReadHandlers } from './strategy.agent.service.js'
import { makeItemStatusHandlers, ITEM_STATUS_TOOL_SPEC } from '../tools/itemStatus.tools.js'
import { REMEMBER_DESCRIPTION } from '../tools/userProfile.tools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG = '[axlAgent]'
// Hot-reload the system prompt on file change (mtime-gated) — no restart needed.
const _systemPrompt = makePromptLoader(join(__dirname, '../../prompts/axl_system_prompt.md'), LOG)
// How deep reception remembers. 20, not the 12 it was: trimHistory cuts on a HIGH-WATER MARK of
// keep × 3, so 12 meant a thread ran to 36 messages and then dropped to the last 6 turns in one
// step — the app's shallowest floor, on the desk most likely to run long. 20 pushes that cliff to 60
// and leaves 10 turns standing on the other side of it. The extra depth is nearly free here: Axl's
// turns are short by construction (BREVITY_RULE), and a longer history costs one cache miss per
// trim, which now happens a third as often. See agentUtils.trimHistory.
const MAX_MESSAGES = DESKS.axl.maxMessages

// Axl is the non-trading meta-layer: the social-chat assistant, app guide, and
// (later) the account-report / trade-analysis concierge. It is READ-ONLY by
// design — it never emits a <trade_idea>, order, or any authoring artifact. That
// discipline is what keeps it from becoming a superset of the three specialists;
// anything about forming or changing a trade/portfolio routes to that
// specialist's own chat. Roles beyond #1 (social bot) + #5 (app help) need
// account/trade data + tools and are added one by one — the VENUE reads are the
// first, since "which account am I on / what am I holding / can I trade this
// here" is a question ABOUT the app, which is Axl's own job, not a desk's.
// Axl now has NO writes at all. `save_objective` was one — it recorded the user's stated goal so a
// desk wouldn't re-ask — and it is gone with the objective record itself (2026-08-05): a goal
// written down became a goal that outlived its job, and reception was interrogating users for
// numbers (risk, horizon) that are the DESK's Phase 1. What crosses the hop now is a sentence, not
// a record — see `<open>` below.
// The reporting reads are APPENDED, never inserted: the snapshot compares by index and prompt
// caching keys off the array prefix, so a mid-array addition both fails three tests instead of one
// and invalidates Axl's cached tool block on every request until it re-warms.
export const TOOLS = toolsFor({
    get_trading_context: TRADING_CONTEXT_TOOL_SPEC.get_trading_context,
    check_broker_symbol: TRADING_CONTEXT_TOOL_SPEC.check_broker_symbol,
    get_watched_items: USER_DATA_TOOL_SPEC.get_watched_items,
    get_performance: USER_DATA_TOOL_SPEC.get_performance,
    get_upcoming_events: USER_DATA_TOOL_SPEC.get_upcoming_events,
    explain_concept: CONCEPT_TOOL_SPEC.explain_concept,
    set_experience_level: EXPERIENCE_TOOL_SPEC.set_experience_level,
    // Appended last, per the rule above. ONE tool, not the five market reads it is built from:
    // Axl relays a brief written elsewhere, which is what keeps the world-facing broadcast from
    // turning into per-user market commentary. See marketBrief.service.js.
    get_market_brief: MARKET_BRIEF_TOOL_SPEC.get_market_brief,
    // Appended last, per the rule above. Axl fields "is the market open?" more than any desk —
    // it is an app question, not a trade question, which is exactly Axl's half of the line.
    get_market_hours: MARKET_HOURS_TOOL_SPEC.get_market_hours,
    // Appended last, per the rule above. The SHOW half of the strategy desk: Axl reports the
    // published view, Pythia is the one who writes or changes it.
    get_industry_views: INDUSTRY_VIEWS_TOOL_SPEC.get_industry_views,
    // Appended last, per the rule above. The brief's sibling, not its overlap: the brief is what the
    // tape DID today, written once for everyone; this is what was WRITTEN about a subject the user
    // named. "How are markets" is the first, "any news on Nvidia" is the second, and a reception desk
    // that can answer only the broadcast half has to send a headline question to a desk that would
    // then have to form a view to answer it.
    get_news: NEWS_TOOL_SPEC.get_news,
    // Appended last, per the rule above. Today's hotlist, so a `<show>hotlist` comes with a line on
    // what is in it (Roy, 2026-10-22). A broadcast, like the brief: the handler is unbound.
    get_hotlist: HOTLIST_TOOL_SPEC.get_hotlist,
    // Appended last, per the rule above. What the brief and the headlines do not cover: a question
    // about global markets or a geopolitical event is Axl's to answer, not a desk's (Roy, 2026-11-06).
    // Unbound like them, since it runs server-side and never sees the user. The two broadcast rules
    // (not joined to their book, no advice) hold here too; they live in the prompt's own section.
    web_search: '',
    // ABOUT THE USER (one-axl.md step 3): a lasting fact the user states — the handler is runAgentStream's. Appended LAST.
    remember_about_user: REMEMBER_DESCRIPTION,
    // SUBAGENTS (docs/design/modes-and-builders.md §3, 2026-11-20): the event analyst and — asked, a
    // builder still (2026-11-21) — the analyst answer through Axl: no route, no floor. Appended last, per the rule above. Its handler is the turn's (desks/subagent.js).
    ask_specialist: `Ask the analyst or the event analyst — its answer comes back to YOU as material (nothing of it is on screen), and you write the reply in your own voice, its findings said as the house's. research_analyst — a deeper question on a company's case the coverage in get_company_view does not answer: a margin trend, a valuation argument, the latest print against the thesis. event_analyst — who a NEW EVENT reaches through the supply chain (suppliers, customers, infrastructure, substitutes), the house's events, a map's scores and flags, a follow-up on a map. How a stock trades is not a specialist's: the measured profile in get_company_view is the house's technical read. Write the question to stand alone (the specialist sees none of this conversation, only its own earlier answers), and name every company with its ticker AND name.`,
    // THE HOUSE'S WORK on one company — coverage, technicals, events, with verdicts; builds what is missing in the background
    // (docs/design/axl-one-voice.md, Roy 2026-11-21). Appended last, per the rule above.
    get_company_view: COMPANY_VIEW_TOOL_SPEC.get_company_view,
    // THE INDUSTRY STRATEGIST'S READS (axl-one-voice.md §7, Roy 2026-11-21) — her handlers, his own descriptions. Appended last.
    get_industry_news: `The last month's news on one sub-industry's largest companies, dated and attributed. Pass \`industry\` (a GICS sub-industry name or code — get_industry_views gives a name's). For "what's going on in semis".`,
    get_industry_moves: `How far one sub-industry has MOVED: its basket against SPY over 12 and 24 months and the last 1 and 3, how stretched it is, the HYPE flag, the market regime. Measured facts, not a forecast.`,
    get_industry_money: `Where the money goes in one sub-industry: its companies' capex, buybacks, dividends and acquisitions (this year against last), insiders buying, funds' crowding, government contracts. Facts to state; capex is the suppliers' revenue.`,
    get_capex_leaders: `Where corporate capex is rising and falling most across the whole market, by industry — follow the money to the industries it lands in. No arguments.`,
    list_themes: `The house's THEMES (the industry strategist's) — each with its thesis and its value chain of sub-industries. For "what themes does the house follow", or to find a theme's id.`,
    get_theme: `One house theme by its id (th_…): the thesis, the value chain link by link with why, how far each link has moved and where its companies put money.`,
    get_geopolitics: `Geopolitical risk, MEASURED: the index of newspaper attention to geopolitical tension against its ten years, and the house's mapped risks (Taiwan Strait, US–China, the Gulf, the Red Sea, Russia–Ukraine…), elevated ones flagged; pass \`industry\` for the risks that touch it. Attention, not impact.`,
    // THE MONITORS' VIEW of one of the user's items (axl-one-voice.md §6, Roy 2026-11-21). Appended last.
    get_item_status: ITEM_STATUS_TOOL_SPEC.get_item_status,
})

// Without the turn's handler (the social chat — a DM, no session to write the specialist's row into) the tool is not offered.
const TOOLS_NO_SPECIALIST = TOOLS.filter(t => t.name !== 'ask_specialist')

// NO `consult` HERE, deliberately — the reasoning sidecar reached the other five desks on
// 2026-08-16 and was pulled back off this one the same day. Not because reception never faces a
// hard call: the critic half of the job does. Because of what the tool costs when it is merely
// DECLARED. Axl is the highest-traffic desk in the app and its tool block carries no cache
// breakpoint, so the declaration rides uncached on every landing-box turn — while the clause that
// would have governed it rules out routing, explaining, and app questions, which is nearly
// everything Axl does. A tool that is read constantly and reached for almost never is the one
// shape where the sidecar loses money.
//
// If it comes back, the argument to beat is that one: give Axl its own cache breakpoint first, or
// wait until the critic role is doing enough volume to pay for the declaration.

// ONE Axl. This turn both converses and routes, which used to be two agents: a `routeIntent` doorman
// on its own tight prompt (no history, no app knowledge) answered the landing box, while the real
// Axl — this one — lived behind a link. The doorman answered app questions anyway, inventing them,
// and could not resolve a follow-up: "give spy" then "now the 4h" charted a ticker it had never been
// told. Routing is now a section of Axl's own prompt and a `<route>` tag on a normal reply, so the
// user gets one Axl that remembers, explains, charts, and hands them to a desk when they want one.

export const axlAgentService = { chatStream }

// ─── Who the user is ───────────────────────────────────────────────────────────
// One desk is admin-only — Pythia (strategy; Aether was the other until 2026-11-18) — and Axl is the way in to every desk, so
// it has to know which user it is talking to or it offers a trader a door that answers 403. The
// house INDUSTRY VIEWS are NOT one of the closed things: they are a broadcast every user may READ
// (get_industry_views), only their AUTHORING is Pythia's. So a trader's Axl still shows them; it
// just never sends them to change one.
//
// Rides the volatile tail of the system prompt, next to the audience block, for the same reason
// that block does: the cached base is shared by every user, and a per-role base would split the
// cache in two for a paragraph.
//
// The list itself lives with the routing mechanism (routing.util), which every desk now shares;
// re-exported here because Axl is where callers learned to find it.
export { ADMIN_DESKS }

/** The role paragraph for the prompt tail. Pure; exported for tests. */
export function buildRoleSection(isAdmin) {
    if (isAdmin) {
        return 'USER ROLE: ADMIN. Every desk is open to them, including the industry strategist (`<route>strategy</route>`, to review or change the house industry views).'
    }
    return [
        'USER ROLE: TRADER. One desk DOES NOT EXIST for this user — the industry strategist (the strategy desk).',
        "Never route to `strategy`, never offer it, never name the industry strategist as somewhere they can go, and leave it out of any list of the app's desks.",
        "The HOUSE INDUSTRY VIEWS are still theirs to read: on \"what does the house think of semis / my names' industries\", call `get_industry_views` and report it as \"the house view\" — the report is the whole answer.",
        'If they ask to SET or CHANGE a view, say the industry views are set centrally by the strategy desk and are not something they author here, offer to show the current one, and end the turn with NO route.',
    ].join(' ')
}

/**
 * Where this turn is answered (unified-chat plan phase 7 CR). The chat is the default and needs no line —
 * a route there lands the desk right below. The SOCIAL CHAT drops every hand-off tag (it is a DM, not the
 * session), so there Axl must not promise one. Pure; exported for tests.
 */
export function buildSurfaceSection(surface) {
    if (surface !== 'social') return ''
    return 'SURFACE: the SOCIAL CHAT (a direct message, not the main chat). Nothing can be handed to a desk from here — no <route>, <edit> or <show> takes effect. Answer what you can; when the user wants a desk, say plainly to continue in the main chat, where that desk will pick it up. Never say a desk "will take it from here". The specialists are not reachable here either — there is no ask_specialist in a direct message: for how a stock trades, who an event reaches, or a view on a company as an investment, say to ask in the main chat, and never pretend to have asked one.'
}

// The grammar — `<route>desk SYMBOL</route>`, `<edit>kind id</edit>`, `<open>…</open>` — and its
// parsers were Axl's own until 2026-09-18, when every desk learned to hand the user on (a user at
// Argus saying "send NVDA to Prometheus"). They live in routing.util now, shared; the reasoning that
// used to sit here — why desk and symbol are one capture, why an edit is a second tag and not a third
// word, why the opening is a sentence and not fields — moved with them. Axl keeps the richer
// routing SECTION of its spine (reception's whole job is deciding where); the mechanism is common.

async function chatStream({ messages = [], audience = null, isAdmin = false, surface = 'chat', model: requestedModel, reasoningEffort, userId, onToken, onToolStart, onReasoning, onChart, signal,
    askSpecialist = null,   // the turn's ask_specialist handler (desks/subagent.js) — null where there is no session
    sessionId = null,       // where a background build's "ready" line goes (get_company_view) — null in a direct message
    specialistHint = null,  // the role the user addressed (the Hotlist's Echo tab, "@event analyst") — Axl asks it
    builds = [],            // the builds in this session, one line each (desks/builds.js buildLines) — step 5b
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
    _tradingContextHandlers = makeTradingContextHandlers,
    _userDataHandlers = makeUserDataHandlers,
    _conceptHandlers = makeConceptHandlers,
    _experienceHandlers = makeExperienceHandlers,
    _marketBriefHandlers = makeMarketBriefHandlers,
    _marketHoursHandlers = makeMarketHoursHandlers,
    _industryViewsHandlers = makeIndustryViewsHandlers,
    _newsHandlers = makeNewsHandlers,
    _hotlistHandlers = makeHotlistHandlers,
    _companyViewHandlers = makeCompanyViewHandlers,
    _industryReadHandlers = makeIndustryReadHandlers,
    _itemStatusHandlers = makeItemStatusHandlers,
    _venueSection = buildVenueSection,
} = {}) {
    // The venue rides the last USER message, not the system prompt: free cash moves whenever
    // anything fills, and a volatile system block sits ahead of the whole conversation in the cache
    // prefix. See buildVenueSection.
    const normalized = attachTurnContext(normalizeMessages(messages, MAX_MESSAGES), await _venueSection(userId))

    // Stable cached base + volatile tail (today's date, so "this week" resolves).
    const today = new Date().toISOString().slice(0, 10)
    const audienceBlock = buildAudienceSection(audience)
    const roleBlock     = buildRoleSection(isAdmin === true)
    const surfaceBlock  = buildSurfaceSection(surface)
    const systemPrompt = [
        cachedBlock(_systemPrompt() + LANGUAGE_RULE + VOICE_RULE + VENUE_RULE + BREVITY_RULE),
        { type: 'text', text: `CURRENT DATE: ${today}. Resolve relative timeframes (today, this week, this month) against this date.

${roleBlock}${builds?.length ? `

BUILDS IN THIS CHAT (they run in the background while you talk; the work pane shows each):
${builds.join('\n')}
Asked how one is going, say its status from this list. A change to one is the builder's: tell the user to pick its mode (the picker on the prompt box) and say it there — never change a build yourself. A READY one is reviewed and saved in the pane (Generate).` : ''}${surfaceBlock ? `

${surfaceBlock}` : ''}${audienceBlock ? `

${audienceBlock}` : ''}` },
    ]

    // The chart tag is captured and emitted by runAgentStream (shared protocol) — Axl only forwards
    // the callback, exactly like every other agent, and that ONE argument is the whole reason a
    // toolless agent can put a chart in its chat at all. <route>/<edit>/<open> are the shared
    // routing capture (routing.util): suppressed from the token stream, stripped from `raw` below
    // because this return value is a second consumer that would otherwise hand the client "…to the
    // trading desk. <route>trade</route>", parsed after the turn.
    let chartRow = null
    // Axl's own key: a desk restricted to named senders (registry routedFrom) checks it.
    const route = makeRouteCapture('axl')
    // <adopt> is a THIRD sibling of <route>, for the same reason <edit> is a second one: "the user
    // already owns this book" is not a destination, it is what the portfolio desk must do on arrival.
    // Squeezing it into the route tag would collide with the symbol slot (`portfolio adopt` vs
    // `portfolio AAPL`), and a mode that arrives as a symbol is a mode that silently never arrives.
    let adoptCapture = false
    // Follow-up chips. The shared pipe collects and cleans them; WHAT to suggest is this agent's
    // own judgment, authored in axl_system_prompt.md.
    const suggest = makeSuggestionCapture()

    const toolHandlers = {
        ..._tradingContextHandlers(userId),
        // The role rides in so the admin-only lists (the research queue) exist for an admin's read
        // and not for a trader's — the same gate the prompt's ROLE line applies to the desks.
        ..._userDataHandlers(userId, { isAdmin: isAdmin === true }),
        // Unbound: an explanation is the same for everyone, which is why it can be authored once.
        ..._conceptHandlers(),
        // Unbound for the same reason, and a stronger one: the brief is the same for every reader,
        // so a handler with no userId is the structural guarantee it stays that way.
        ..._marketBriefHandlers(),
        // Unbound too — market hours belong to the instrument, not the user.
        ..._marketHoursHandlers(),
        // Unbound for the brief's reason exactly: the house sector view is a BROADCAST, so a handler
        // that cannot see a user cannot leak one into it.
        ..._industryViewsHandlers(),
        // Unbound as well, and here it is the load-bearing kind: the tool that fetches headlines about
        // a name the user very likely holds is the one that must not be able to see that they hold it.
        ..._newsHandlers(),
        // Unbound: the hotlist is built once for everyone.
        ..._hotlistHandlers(),
        ..._experienceHandlers(userId),
        // Bound to the user (their own events) and the session (the "ready" line).
        ..._companyViewHandlers({ userId, sessionId }),
        // Unbound: the industry strategist's work is the house's, the same for every reader.
        ..._industryReadHandlers(),
        // Bound: the user's own items, owner-checked.
        ..._itemStatusHandlers(userId),
        ...(askSpecialist ? { ask_specialist: askSpecialist } : {}),
    }
    // The user addressed a specialist (a tab, a mention): the question is its — Axl asks it rather than answering.
    const conversation = specialistHint && askSpecialist
        ? attachTurnContext(normalized, `[App note, not the user's words: the user asked this of the ${specialistHint.role} — call ask_specialist with specialist "${specialistHint.key}" unless it is plainly not that role's question.]`)
        : normalized

    const raw = await _run({
        log: LOG, requestedModel, userId,
        messages: conversation, systemPrompt,
        tools: askSpecialist ? TOOLS : TOOLS_NO_SPECIALIST, toolHandlers,
        reasoningEffort, signal, onToken,
        tagCaptures: buildTagCaptures({
            ...route.captures,
            adopt: () => { adoptCapture = true },
            suggest: suggest.onCapture,
        }),
        onToolStart, onReasoning,
        onChart: (row) => { chartRow = row; onChart?.(row) },
    })

    const reply = cleanReply(raw)
    // No desk, no opening; no opening on an edit; no show beside either — the capture gates the
    // four tags against each other (see makeRouteCapture).
    const { route: desk, routeSymbol: symbol, opening, edit, show } = route.result()

    // Chips are for a turn that STAYS here. When Axl is handing the user to a desk, the door he
    // just opened is the next step — offering three other questions beside it competes with the
    // one thing he decided. The prompt says the same; this guard is what makes it true, exactly as
    // the `opening` line above guards its own tag rather than trusting the tag to arrive correctly.
    const suggestions = (desk || edit) ? [] : suggest.result()

    // Only ever alongside the PORTFOLIO desk, and never alongside an edit. Gated here for the reason
    // `opening` and `routeSymbol` are: a mode with no desk to arrive at is a flag nothing reads, and
    // an edit reopens a book that already exists — adoption is how a book that exists ELSEWHERE
    // arrives, so the two cannot both be true.
    const adopt = (adoptCapture && desk === 'portfolio' && !edit)

    logger.info(LOG, 'chatStream done', { route: desk, routeSymbol: symbol, adopt, edit: edit ? `${edit.kind}:${edit.ref}` : null, show: show ? `${show.kind}:${show.ref}` : null, opening: opening ? opening.length : null, suggestions: suggestions.length, replyLength: reply.length })
    // `chart` on the return is the REQUEST, never the image: the row already went out on its own
    // event and doubling it here would double the bytes on the wire.
    return {
        reply,
        route: desk,
        routeSymbol: symbol,
        adopt,
        // { kind, ref, desk } — reopen this exact item. Stands apart from `route` rather than
        // folding into it: a route hands over a desk and a blank page, an edit hands over a document.
        edit,
        // { kind, ref } — open this exact item's own detail window: the chart, the plan, the
        // monitor's journal. No desk, because a detail view belongs to none, and no opening, because
        // nothing is being said to anyone — "show me what's going on with this one" is a look.
        show,
        // The desk's first turn, in the user's words. The client sends it as their message on
        // arrival, so the desk starts on the job instead of asking what they came for.
        opening,
        // Up to three follow-ups the user can send with one click. Empty on a routing turn.
        suggestions,
        chart: chartRow ? { ticker: chartRow.symbol, timeframe: chartRow.timeframe } : null,
    }
}
