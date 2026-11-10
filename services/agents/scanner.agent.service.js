import { fileURLToPath }  from 'url'
import { makePhaseCapture, runAgentStream } from '../agentIO.js'
import { toolsFor } from '../agentTools.registry.js'
import { consultDescription } from '../deepThink.service.js'
import { dirname, join }  from 'path'
import { getQuotes } from '../../providers/yahoofinance.provider.js'
import { getRiskMetrics, getPriceAction, getCycleAnalysis } from '../priceAnalytics.service.js'
import { getFundamentals, getEarningsCalendar, getEarnings, screenCandidates, getMarketMovers, getAnalystActions, getSectorSnapshot } from '../../providers/fmp.provider.js'
import { getSecFilings } from '../../providers/sec.provider.js'
import { makeCandlesHandler, makeIndicatorsHandler, makeChartHandler } from '../tools/marketData.tools.js'
import { makeStructureVisionHandler, OB_VISION, FB_VISION } from '../tools/priceStructure.tools.js'
import { logger }        from '../logger.service.js'
import { makeNewsHandlers } from '../tools/news.tools.js'
import { COMMON_TOOL_HANDLERS, normalizeMessages, makePromptLoader, cleanReply, makeToolHandler, buildAudienceSection, attachTurnContext, LANGUAGE_RULE, BREVITY_RULE, VENUE_RULE, cachedBlock } from '../agentUtils.js'
import { makeTradingContextHandlers, buildVenueSection } from '../tools/tradingContext.tools.js'
import { makeMarketHoursHandlers, MARKET_HOURS_TOOL_SPEC } from '../tools/marketHours.tools.js'
import { makeHouseIndustriesHandlers, HOUSE_INDUSTRIES_TOOL_SPEC } from '../tools/houseIndustries.tools.js'
import { houseLabels, wireLabel } from '../houseLabel.service.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { DESKS } from '../desks/registry.js'
import { makeRouteCapture, buildRouteRule } from '../routing.util.js'
import { isToolError } from '../toolResult.util.js'
import { makeGroundingLedger, recordSourced, recordTouched, groundingTier, DISCOVERY_TOOLS, PER_NAME_TICKER_ARGS, SOURCED_EXTRACT } from '../scanner.grounding.js'

const __dirname     = dirname(fileURLToPath(import.meta.url))
const LOG   = '[scannerAgent]'
// The spine (scanner_system_prompt.md) is still the trading screen it always was, and the hand-off module rides
// on it — since 2026-11-09 on EVERY turn: Argus's list-building chat (the investing profile, the radar cut, the
// saved lists) is archived, and the single pick for Mentor is the one mode left (archive/README.md). The full
// service as it was is archive/services/agents/scanner.agent.service.js. Hot-reloaded.
const _spinePrompt = makePromptLoader(join(__dirname, '../../prompts/scanner_system_prompt.md'), LOG)
const _handoffMode = makePromptLoader(join(__dirname, '../../prompts/scanner_mode_handoff.md'), LOG)
const MAX_MESSAGES = DESKS.scanner.maxMessages

export const TOOLS = toolsFor({
    web_search: '',
    get_trading_context: `The user's trading venue + accounts: which modes are available (paper / live / manual), which live brokers are connected, and every account with its balance, capabilities and open positions. Use it to keep a list ACTIONABLE — the account size a name has to be sizeable in, and what the user already holds. No arguments.`,
    check_broker_symbol: `Check whether a candidate is actually TRADABLE at the user's connected live broker, and what the broker calls it. A name that screens beautifully but the broker does not list is a dead candidate — check before you commit it to the list, and drop or flag it if it is unavailable. tradable null means the broker could not be reached: UNKNOWN, never treat as unavailable.`,
    screen_candidates: `Screen the US universe for names that fit the scan's shape — the grounded discovery leg (Phase 2). Filter by sector, market cap, price, beta, dividend, and a liquidity floor (volume). NOTE: this is a FUNDAMENTAL & liquidity screen — it CANNOT filter for chart setups (52-week-high, base, RSI). For a technical angle, use it to define a liquid, in-sector universe, then confirm the setup per-name with get_candles/get_indicators. Returns a compact list; qualify each hit before listing it.`,
    get_market_movers: `Today's biggest movers — the momentum / gap / "what's moving" starting pool for Phase-2 discovery. kind="gainers" (biggest % up), "losers" (biggest % down — short pool), or "active" (highest volume). Grounded discovery, not a watchlist: qualify every name (relative strength, tradability, a real catalyst) before it makes the list. US-listed.`,
    get_sector_snapshot: `Today's sector rotation — every sector ranked leaders→laggards by average move. Use it in Phase 2 for a sector-rotation angle (find the leading/lagging groups, then screen_candidates INSIDE them), and in Phase 3 as the sector leg of the relative-strength check (is the name's sector leading?). No arguments.`,
    get_analyst_actions: `Recent analyst rating changes — a catalyst pool beyond earnings. With NO symbols: the market-wide latest upgrades/downgrades feed (Phase-2 discovery of ratings-driven names). With symbols: each name's recent rating actions (Phase-3 validation of a shortlist — is a fresh upgrade/downgrade backing the move?). US-listed equities.`,
    get_price_action: `Recent price-action summary for a ticker: 1d/5d/1m/3m moves, position within the 1y range, and relative volume. Use it to confirm a name is actually moving the way your thesis claims.`,
    get_quotes: `Get current prices for several tickers at once.`,
    get_risk_metrics: `Annualized volatility and ATR (from 1y of daily prices) for a ticker. Use it to gauge how violent a name is before putting it on the list.`,
    get_candles: `Fetch recent OHLCV candles for a ticker + timeframe — the exact price structure to name the setup and run the structure-respect check (swing highs/lows, prior-day levels, breakout shelves, base/range). Baseline Phase-3 tool: read the structure from the candles before you score \`technical\`. Always call it before committing to a named setup or a level.`,
    get_indicators: `Compute exact indicator VALUES from recent candles — the SAME math the monitor uses (EMA, SMA, RSI, MACD, ATR, VWAP). Use it to CONFIRM the technical read with hard numbers: price vs EMA/VWAP for location, RSI for momentum/divergence, MACD for trend, ATR for how violent the name is. Price action / structure (get_candles) leads; indicators only confirm — a name clean on price with soft indicators is a lower \`technical\` score, not a reject.`,
    get_chart: {
        description: `Render an actual candlestick chart IMAGE (KLineCharts, optional indicator overlays) and look at it directly for VISUAL / structural analysis — chart patterns, trend, where price sits vs moving averages / VWAP, base/breakout geometry. Use it to CONFIRM the named setup on the strongest names. EXPENSIVE (image render + vision) — reserve it for the top shortlist and the hand-off single-pick, NOT every candidate. For exact numeric levels prefer get_candles.`,
        omit: ["show_to_user"],
    },
    get_orderblocks: {
        description: `Detect ORDER BLOCKS on a plain candlestick chart (one ticker + timeframe): the last opposing candle/cluster before an impulsive structure break, whether it is fresh/untested or mitigated, and its zone vs current price. Angle-triggered — reach for it when the scan angle is structure / supply-demand / entry-zone hunting. Levels are approximate; confirm exact prices with get_candles.`,
        omit: ["show_to_user"],
    },
    get_false_breaks: {
        description: `Detect FALSE BREAKS / liquidity sweeps on a plain candlestick chart (one ticker + timeframe): where price pushed beyond a clear prior high/low, failed, and closed back inside the range (a stop run / trap), whether the level was reclaimed, and how recent. Angle-triggered — reach for it for a failed-breakout / reversal / squeeze angle. Levels are approximate; confirm exact prices with get_candles.`,
        omit: ["show_to_user"],
    },
    get_fundamentals: `Company fundamentals for a single ticker: sector/industry, market cap, valuation, margins, ROE, growth. Use it to qualify a longer-horizon pick. ETFs return exposure/profile only.`,
    get_earnings: `For a SINGLE ticker: its next earnings date + EPS estimate, plus the last 4 quarterly EPS actuals vs estimates (with surprise %). Use it to qualify one scan candidate — is a print imminent (gap risk), and does the name have a track record of beating or missing. For the forward "who reports when" across a period, use get_earnings_calendar. US equities only.`,
    get_earnings_calendar: `Upcoming earnings dates (with EPS/revenue estimates) between two dates (YYYY-MM-DD, window up to ~3 months). Optionally filter to specific symbols. Use it for the forward-looking "who reports when" — especially for week/multi-day scans. Pass symbols when you have them: a market-wide ask returns only the soonest rows, and says so.`,
    get_sec_filings: `What a company has actually filed with the SEC: latest 8-K (item 2.02 = the real earnings release), 10-Q, 10-K, with dates and links. Use it to confirm an earnings event truly dropped. US filers only; most ETFs and foreign tickers aren't in EDGAR.`,
    get_cycle_analysis: {
        description: `Detect recurring cycles in a stock's price history. Two modes: "price" finds the dominant peak-to-peak / trough-to-trough interval, tells you the current phase, and estimates the next turning point. "calendar" shows how the stock behaved in a specific calendar window (e.g. late June) over the past 3–5 years — average return, hit rate, and whether this year is tracking with the historical pattern. Use "price" for recurring-interval / cyclic-window theses ("cycles every ~6 weeks"); use "calendar" for seasonal / calendar-pattern theses ("June is always weak"). The angle makes the mode clear — pick it directly rather than asking which they mean.`,
        omit: ["timeframe"],
    },
    get_short_interest: `Short interest for a US-listed single stock/ADR: short % of float, days-to-cover (short ratio), and month-over-month change. FINRA data, reported bi-monthly with a ~2-week lag — use it for squeeze potential and crowded-bearish-positioning context on a scan candidate, not as a live read. No data for ETFs, crypto, FX or futures.`,
    get_options_context: `Options positioning for a US equity/ETF: put/call ratio (by open interest and by volume) and at-the-money implied volatility for the nearest expiry. Use it to gauge directional skew and how big a move the market is pricing (elevated IV = expensive options / large expected move, often around a catalyst). Quotes ~15-min delayed. No data for crypto, FX or futures.`,
    get_derivatives_context: {
        description: `Crypto-perp positioning from Binance: funding rate (who pays to hold the trade — a crowding signal), open interest (committed leverage), and the global long/short account ratio (retail skew). This is the crypto analog to short-interest/options sentiment. Crypto perps only (BTC, ETH, SOL…) — not equities, FX or traditional futures.`,
        cache: true,
    },
    // APPENDED, never inserted — the snapshot compares by index and prompt caching keys off the
    // array prefix.
    get_market_hours: MARKET_HOURS_TOOL_SPEC.get_market_hours,
    // Pythia's industries for the scan's book — where a swing / long-term scan looks FIRST (argus-on-pythia.md §3.2).
    // Inserted before `consult`, which stays last.
    get_house_industries: HOUSE_INDUSTRIES_TOOL_SPEC.get_house_industries,
    // Argus had web search and no news feed (Roy, 2026-10-24: "Argus needs a news tool") — inserted before `consult`.
    get_news: `Recent NEWS on a name — dated, attributed headlines with the publisher's own summary, newest first. \`companies\` with the TICKER as \`subject\` is the one you reach for: is there a real, DATED story under this move, or a stale or recycled one? It is the first place to look before web_search — cached and dated where a search is neither. \`topic\` for a theme with no ticker; \`headlines\` for the market's front page. A headline is a fact to weigh — what was WRITTEN — never a level or a call.`,
    // Appended last — contractually. The reasoning sidecar (services/deepThink.service.js): one
    // bounded decision put to a stronger model and handed back as a tool result. The mechanism half
    // of this description is shared with every other desk; the clause below is Argus's own judgment
    // about WHEN.
    //
    // Argus needs the TIGHTEST clause of any desk, and this one says so explicitly: a scan is
    // dozens of names, and a desk that consults per candidate turns a cost saving into a per-scan
    // multiplier. The two cases below are both once-per-scan by construction.
    consult: consultDescription(`This desk screens in BULK, so the bar is higher here than anywhere else: a consult per candidate would cost more than the scan is worth. Reach for it in exactly two situations, both of which happen at most once per scan: **the final cut**, when two or three finalists are genuinely close and the ranking is the thing the user will act on; and **an angle that resists screening** — a thesis the tools cannot express, where you have to decide what to screen FOR before you can screen at all. Never per candidate, and never to qualify a name a tool call would qualify.`),
})

const TOOL_HANDLERS = {
    screen_candidates: makeToolHandler('screen_candidates',
        (filters) => screenCandidates(filters || {}),
        (err) => `Could not run screen: ${err.message}`, LOG),
    get_market_movers: makeToolHandler('get_market_movers',
        ({ kind, limit }) => getMarketMovers(kind, limit),
        (err) => `Could not fetch market movers: ${err.message}`, LOG),
    get_sector_snapshot: makeToolHandler('get_sector_snapshot',
        () => getSectorSnapshot(),
        (err) => `Could not fetch sector snapshot: ${err.message}`, LOG),
    get_analyst_actions: makeToolHandler('get_analyst_actions',
        ({ symbols, limit }) => getAnalystActions(Array.isArray(symbols) ? symbols : [], limit),
        (err) => `Could not fetch analyst actions: ${err.message}`, LOG),
    get_candles:    makeCandlesHandler(LOG),
    get_indicators: makeIndicatorsHandler(LOG),
    // Vision tools (KLineCharts render + visual read). onChart: null → the image goes to
    // the LLM only, not the scan UI. This is DELIBERATE: the scanner does not surface charts
    // to the user (decided 2026-07-22) — the render is an internal vision read, not a deliverable.
    get_chart:        makeChartHandler({ log: LOG, onChart: null, readText: 'Read the price STRUCTURE visually — trend, base/breakout geometry, S/R, where price sits vs any overlays. Confirm the named setup; indicators only confirm, never lead.' }),
    get_orderblocks:  makeStructureVisionHandler({ log: LOG, kind: 'orderblocks',  vision: OB_VISION, onChart: null }),
    get_false_breaks: makeStructureVisionHandler({ log: LOG, kind: 'false_breaks', vision: FB_VISION, onChart: null }),

    get_price_action: makeToolHandler('get_price_action',
        ({ ticker }) => getPriceAction(ticker),
        (err, { ticker }) => `Could not fetch price action for ${ticker}: ${err.message}`, LOG),
    get_quotes: makeToolHandler('get_quotes',
        ({ tickers }) => getQuotes(tickers),
        (err) => `Could not fetch quotes: ${err.message}`, LOG),
    get_risk_metrics: makeToolHandler('get_risk_metrics',
        ({ ticker }) => getRiskMetrics(ticker),
        (err, { ticker }) => `Could not fetch risk metrics for ${ticker}: ${err.message}`, LOG),
    get_fundamentals: makeToolHandler('get_fundamentals',
        ({ ticker }) => getFundamentals(ticker),
        (err, { ticker }) => `Could not fetch fundamentals for ${ticker}: ${err.message}`, LOG),
    get_earnings: makeToolHandler('get_earnings',
        ({ ticker }) => getEarnings(ticker),
        (err, { ticker }) => `Could not fetch earnings for ${ticker}: ${err.message}`, LOG),
    get_earnings_calendar: makeToolHandler('get_earnings_calendar',
        ({ from, to, symbols }) => getEarningsCalendar(from, to, Array.isArray(symbols) ? symbols : []),
        (err) => `Could not fetch earnings calendar: ${err.message}`, LOG),
    get_sec_filings: makeToolHandler('get_sec_filings',
        ({ ticker }) => getSecFilings(ticker),
        (err, { ticker }) => `Could not fetch SEC filings for ${ticker}: ${err.message}`, LOG),
    get_cycle_analysis: makeToolHandler('get_cycle_analysis',
        ({ ticker, mode, calendar_window, lookback_years }) => getCycleAnalysis(ticker, mode, calendar_window ?? null, lookback_years ?? 4),
        (err, { ticker }) => `Could not compute cycle analysis for ${ticker}: ${err.message}`, LOG),
    ...COMMON_TOOL_HANDLERS,
    ...makeNewsHandlers(),
    // Unbound (market hours belong to the instrument, not the user) — so it lives in the
    // static map, unlike the venue handlers that are rebuilt per request around a userId.
    ...makeMarketHoursHandlers(),
    ...makeHouseIndustriesHandlers(),
}

// Wrap the module-level handlers with a per-session grounding recorder. A
// successful discovery call feeds its output text to the tape (`sourced`); a
// successful per-name call records the ticker it ran on (`touched`). A failed
// call (toolError — e.g. a bogus symbol that errored) confers nothing, so a
// fabricated ticker the model merely *attempted* never gets credited.
function _wrapForGrounding(handlers, ledger) {
    const wrapped = {}
    for (const [name, fn] of Object.entries(handlers)) {
        const reader = PER_NAME_TICKER_ARGS[name]
        const isDiscovery = DISCOVERY_TOOLS.has(name)
        // `ctx` rides through untouched: it is the loop's booking hook, and get_orderblocks /
        // get_false_breaks (both per-name tools, so both wrapped here) spend a model call of
        // their own that must reach it.
        wrapped[name] = (reader || isDiscovery)
            ? async (args, ctx) => {
                const ret = await fn(args, ctx)
                if (!isToolError(ret)) {
                    if (isDiscovery && typeof ret === 'string') recordSourced(ledger, SOURCED_EXTRACT[name] ? SOURCED_EXTRACT[name](ret) : ret)
                    if (reader) recordTouched(ledger, reader(args))
                }
                return ret
            }
            : fn
    }
    return wrapped
}

export const scannerAgentService = { chatStream }

// Exported for unit tests.
export { _wrapForGrounding }

// The DESTINATION belongs here and not in the module for a mechanical reason: the module is a cached
// block, so interpolating a per-request desk name into it would give every destination its own cache
// entry and defeat the breakpoint. The volatile tail is already rebuilt per turn, so naming the desk
// here is free.
const HANDOFF_DESKS = {
    mentor: 'Mentor, which builds a `setup` the user shapes level by level',
}

function _handoffContext(handoffTo) {
    const desk = HANDOFF_DESKS[handoffTo] ?? 'the build desk that sent them'
    return `ACTIVE MODE: BUILD HAND-OFF — the user was sent here by ${desk}, to find ONE ticker to build a single trade on. Refer to that desk by that name. The BUILD HAND-OFF MODE module is in force: it replaces the list-building shape of the spine.`
}

async function chatStream({ messages = [], model: requestedModel, handoffTo = 'mentor', audience = null, reasoningEffort, userId, onToken, onTicker, onPhase, onToolStart, onReasoning, onChart, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
    _venueSection = buildVenueSection,
}) {
    // The venue (mode / broker / accounts / free cash) rides the last USER message rather than the
    // system tail: free cash moves whenever anything fills, so a volatile system block would sit
    // ahead of the whole conversation in the cache prefix. See buildVenueSection.
    const normalized = attachTurnContext(normalizeMessages(messages, MAX_MESSAGES), await _venueSection(userId))

    // Per-session grounding ledger — records which tickers a real, successful tool engaged. It used to drop
    // fabricated names from a list; with lists archived it stamps the pick's provenance (`grounding`) for the log.
    const ledger = makeGroundingLedger()
    const toolHandlers = _wrapForGrounding({ ...TOOL_HANDLERS, ...makeTradingContextHandlers(userId) }, ledger)

    // Stable cached base + volatile tail: today's date (so "next week" resolves) and the mode line.
    const today = new Date().toISOString().slice(0, 10)
    const dynamic = [`CURRENT DATE: ${today}. Resolve all relative timeframes (today, next week, this month) against this date.`]
    const audienceSection = buildAudienceSection(audience)
    if (audienceSection) dynamic.push(audienceSection)
    dynamic.push(_handoffContext(handoffTo))

    // Spine (cached) + the hand-off module (its own cached block) + the volatile tail.
    // BREAKPOINT BUDGET: four per request. Tools take one, the history takes one
    // (_stampHistoryCache in the Anthropic provider), and the system prompt two. Do not add a third.
    const systemPrompt = [
        cachedBlock(_spinePrompt() + buildRouteRule('scanner') + LANGUAGE_RULE + VENUE_RULE + BREVITY_RULE),
        cachedBlock(_handoffMode()),
        { type: 'text', text: dynamic.join('\n\n') },
    ]

    let capturedPick = null
    // <route>/<open>: the user asked to be sent to another desk with a name (routing.util).
    const route = makeRouteCapture('scanner')

    const onPick = (json) => { try { capturedPick = JSON.parse(json) } catch { /* malformed — ignore */ } }
    const phase = makePhaseCapture(4, onPhase)

    // All known emit tags suppressed by default — a stray <scan_list> from the spine is swallowed, never shown.
    // This agent captures phase, ticker (which keeps its inner text in the UI), argus_pick and the routing tags.
    const tagCaptures = buildTagCaptures({
        phase:       phase.capture,
        ticker:      { onCapture: onTicker, keepText: true },
        argus_pick: onPick,
        ...route.captures,
    })

    const raw = await _run({
        log: LOG, requestedModel, userId,
        messages: normalized, systemPrompt,
        tools: TOOLS,
        toolHandlers,
        // onChart here is the <chart> TAG only — the user asking to see a chart. The scanner's
        // vision TOOLS stay wired to onChart:null (see TOOL_HANDLERS): its own renders remain
        // model-only. Same pipe, different judgment.
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning, onChart,
    })

    const reply = cleanReply(raw)

    const pick = _normalizeArgusPick(capturedPick)
    if (pick) pick.grounding = groundingTier(pick.ticker, ledger)
    await _attachPickLabel(pick)
    const routing = route.result()   // { route, routeSymbol, opening, edit } — the controller validates

    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasPick: !!pick, grounding: pick?.grounding ?? null, route: routing.route, phase: phase.get() })
    return { reply, phase: phase.get(), ...(pick ? { pick } : {}), ...routing }
}

/**
 * The house label on the pick (houseLabel.service; argus-on-pythia.md §3.4) — worked out by CODE from the name's
 * industry and the house's lists, never taken from the model. Both books, the swing list first — Mentor builds
 * either. Mutates the pick in place; a failed read leaves it unlabelled. Exported for tests.
 */
export async function _attachPickLabel(pick, { labels = houseLabels } = {}) {
    if (!pick?.ticker) return
    const m = await labels([pick.ticker], { books: ['swing', 'long_term'] })
    pick.house = wireLabel(m.get(pick.ticker))
}

// Normalize a captured <argus_pick> — the single ticker Argus recommends back to Mentor.
// Pure: null when there's no usable ticker, else a clean
// {ticker, direction, thesis, analysis} (direction defaults long; the analysis seeds Mentor's read).
// Exported for tests.
export function _normalizeArgusPick(p) {
    if (!p || typeof p !== 'object' || typeof p.ticker !== 'string' || !p.ticker.trim()) return null
    return {
        ticker:    p.ticker.toUpperCase().trim(),
        direction: p.direction === 'short' ? 'short' : 'long',
        thesis:    typeof p.thesis === 'string' ? p.thesis : '',
        analysis:  typeof p.analysis === 'string' ? p.analysis : '',
        // No build lens: Argus stopped recommending one (2026-11-01, docs/design/mentor-modes.md) — a hand-off
        // carries no setup of the user's, so Mentor opens it risk-based.
    }
}
