import { fileURLToPath }  from 'url'
import { makePhaseCapture, runAgentStream } from '../agentIO.js'
import { toolsFor } from '../agentTools.registry.js'
import { consultDescription } from '../deepThink.service.js'
import { dirname, join }  from 'path'
import { getQuotes } from '../../providers/yahoofinance.provider.js'
import { getRiskMetrics, getPriceAction, getCycleAnalysis } from '../priceAnalytics.service.js'
import { getFundamentals, getEarningsCalendar, getEarnings } from '../../providers/fmp.provider.js'
import { getSecFilings } from '../../providers/sec.provider.js'
import { makeCandlesHandler, makeIndicatorsHandler, makeChartHandler } from '../tools/marketData.tools.js'
import { makeStructureVisionHandler, OB_VISION, FB_VISION } from '../tools/priceStructure.tools.js'
import { logger }        from '../logger.service.js'
import { makeNewsHandlers } from '../tools/news.tools.js'
import { COMMON_TOOL_HANDLERS, normalizeMessages, makePromptLoader, cleanReply, makeToolHandler, buildAudienceSection, attachTurnContext, LANGUAGE_RULE, VOICE_RULE, BREVITY_RULE, VENUE_RULE, cachedBlock } from '../agentUtils.js'
import { makeTradingContextHandlers, buildVenueSection } from '../tools/tradingContext.tools.js'
import { makeMarketHoursHandlers, MARKET_HOURS_TOOL_SPEC } from '../tools/marketHours.tools.js'
import { makeHorizonListHandlers, houseListNames, HORIZON_LIST_TOOL_SPEC } from '../tools/horizonList.tools.js'
import { houseLabels, wireLabel } from '../houseLabel.service.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { DESKS } from '../desks/registry.js'
import { makeRouteCapture, buildRouteRule } from '../routing.util.js'
import { REMEMBER_DESCRIPTION } from '../tools/userProfile.tools.js'

const __dirname     = dirname(fileURLToPath(import.meta.url))
const LOG   = '[scannerAgent]'
// Argus is the PICKER (docs/design/argus-rework.md, Roy 2026-11-11): Mentor sends a user with no name, Argus reads the
// house's list for the trade's horizon (get_horizon_list) and picks ONE name from it — never from the whole market. One
// prompt (scanner_system_prompt.md); the list-building spine and the hand-off module that overrode it are gone. The
// list-building desk as it was is archive/services/agents/scanner.agent.service.js. Hot-reloaded.
const _prompt = makePromptLoader(join(__dirname, '../../prompts/scanner_system_prompt.md'), LOG)
const MAX_MESSAGES = DESKS.scanner.maxMessages

// TURNED OFF 2026-11-21 (Roy: "turn off the tools not in use" — never called in 47 traced replies; Argus picks from
// the horizon list, price action and the news): the candle, indicator, chart, order-block, false-break and cycle reads,
// short interest, options, filings and crypto positioning. Their handlers stay below — declaring one again turns it on.
export const TOOLS = toolsFor({
    web_search: '',
    get_trading_context: `The user's trading venue + accounts: which modes are available (paper / live / manual), which live brokers are connected, and every account with its balance, capabilities and open positions. Use it to keep a list ACTIONABLE — the account size a name has to be sizeable in, and what the user already holds. No arguments.`,
    check_broker_symbol: `Check whether a candidate is actually TRADABLE at the user's connected live broker, and what the broker calls it. A name that screens beautifully but the broker does not list is a dead candidate — check before you commit it to the list, and drop or flag it if it is unavailable. tradable null means the broker could not be reached: UNKNOWN, never treat as unavailable.`,
    get_price_action: `Recent price-action summary for a ticker: 1d/5d/1m/3m moves, position within the 1y range, and relative volume. Use it to confirm a name is actually moving the way your thesis claims.`,
    get_quotes: `Get current prices for several tickers at once.`,
    get_risk_metrics: `Annualized volatility and ATR (from 1y of daily prices) for a ticker. Use it to gauge how violent a name is before putting it on the list.`,
    get_fundamentals: `Company fundamentals for a single ticker: sector/industry, market cap, valuation, margins, ROE, growth. Use it to qualify a longer-horizon pick. ETFs return exposure/profile only.`,
    get_earnings: `For a SINGLE ticker: its next earnings date + EPS estimate, plus the last 4 quarterly EPS actuals vs estimates (with surprise %). Use it to qualify one scan candidate — is a print imminent (gap risk), and does the name have a track record of beating or missing. For the forward "who reports when" across a period, use get_earnings_calendar. US equities only.`,
    get_earnings_calendar: `Upcoming earnings dates (with EPS/revenue estimates) between two dates (YYYY-MM-DD, window up to ~3 months). Optionally filter to specific symbols. Use it for the forward-looking "who reports when" — especially for week/multi-day scans. Pass symbols when you have them: a market-wide ask returns only the soonest rows, and says so.`,
    // APPENDED, never inserted — the snapshot compares by index and prompt caching keys off the
    // array prefix.
    // The cache breakpoint (on the crypto-positioning tool until it was turned off, 2026-11-21).
    get_market_hours: { description: MARKET_HOURS_TOOL_SPEC.get_market_hours, cache: true },
    // Argus had web search and no news feed (Roy, 2026-10-24: "Argus needs a news tool") — inserted before `consult`.
    get_news: `Recent NEWS on a name — dated, attributed headlines with the publisher's own summary, newest first. \`companies\` with the TICKER as \`subject\` is the one you reach for: is there a real, DATED story under this move, or a stale or recycled one? It is the first place to look before web_search — cached and dated where a search is neither. \`topic\` for a theme with no ticker; \`headlines\` for the market's front page. A headline is a fact to weigh — what was WRITTEN — never a level or a call.`,
    // The house's list for the trade's horizon — the only names Argus picks from (argus-rework.md §3.1). Before `consult`.
    get_horizon_list: HORIZON_LIST_TOOL_SPEC.get_horizon_list,
    // Appended last — contractually. The reasoning sidecar (services/deepThink.service.js): one
    // bounded decision put to a stronger model and handed back as a tool result. The mechanism half
    // of this description is shared with every other desk; the clause below is Argus's own judgment
    // about WHEN.
    //
    // Argus picks from a list he is handed, so the one decision worth a stronger model is the final choice between close
    // names — once per pick by construction.
    // ABOUT THE USER (one-axl.md step 3): a lasting fact the user states — the handler is runAgentStream's.
    remember_about_user: REMEMBER_DESCRIPTION,
    consult: consultDescription(`Reach for it in one situation only: **the final pick**, when two or three names on the list are genuinely close and the choice is the thing the user will build on. Never per name, and never to judge a name a tool call would qualify.`),
})

const TOOL_HANDLERS = {
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
}

export const scannerAgentService = { chatStream }

async function chatStream({ messages = [], model: requestedModel, audience = null, reasoningEffort, userId, onToken, onTicker, onPhase, onToolStart, onReasoning, onChart, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
    _venueSection = buildVenueSection,
    _listDeps = undefined,   // test seam: the list reads (horizonList.tools deps)
}) {
    // The venue (mode / broker / accounts / free cash) rides the last USER message rather than the
    // system tail: free cash moves whenever anything fills, so a volatile system block would sit
    // ahead of the whole conversation in the cache prefix. See buildVenueSection.
    const normalized = attachTurnContext(normalizeMessages(messages, MAX_MESSAGES), await _venueSection(userId))

    // THE PICK GATE: every name a list call showed him this turn. A pick that is not among them gets a second look at
    // the house's lists (below), and is dropped if it is not there either — code holds him to the list
    // (argus-rework.md §3.1); the prompt only asks.
    const listed = new Set()
    const toolHandlers = {
        ...TOOL_HANDLERS,
        ...makeTradingContextHandlers(userId),
        ...makeHorizonListHandlers({ onNames: (names) => names.forEach(n => listed.add(String(n).toUpperCase())), deps: _listDeps }),
    }

    // Stable cached base + volatile tail: today's date (so "this week" resolves).
    const today = new Date().toISOString().slice(0, 10)
    const dynamic = [`CURRENT DATE: ${today}. Resolve all relative timeframes (today, next week, this month) against this date.`]
    const audienceSection = buildAudienceSection(audience)
    if (audienceSection) dynamic.push(audienceSection)

    // The prompt (cached) + the volatile tail. BREAKPOINT BUDGET: four per request — tools one, the history one
    // (_stampHistoryCache in the Anthropic provider), the system prompt one.
    const systemPrompt = [
        cachedBlock(_prompt() + buildRouteRule('scanner') + LANGUAGE_RULE + VOICE_RULE + VENUE_RULE + BREVITY_RULE),
        { type: 'text', text: dynamic.join('\n\n') },
    ]

    let capturedPick = null
    // A background trade build's "find one for me" (modes-and-builders.md M18, step 8): two or three names, the user picks.
    let capturedCandidates = null
    // <route>/<open>: the user asked to be sent to another desk with a name (routing.util).
    const route = makeRouteCapture('scanner')

    const onPick = (json) => { try { capturedPick = JSON.parse(json) } catch { /* malformed — ignore */ } }
    const onCandidates = (json) => { try { capturedCandidates = JSON.parse(json) } catch { /* malformed — ignore */ } }
    const phase = makePhaseCapture(4, onPhase)

    // All known emit tags suppressed by default — a stray <scan_list> from the spine is swallowed, never shown.
    // This agent captures phase, ticker (which keeps its inner text in the UI), argus_pick and the routing tags.
    const tagCaptures = buildTagCaptures({
        phase:       phase.capture,
        ticker:      { onCapture: onTicker, keepText: true },
        argus_pick: onPick,
        argus_candidates: onCandidates,
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

    let reply = cleanReply(raw)

    const routed = route.result()   // { route, routeSymbol, opening, edit } — the controller validates
    let routing = routed
    let pick = _normalizeArgusPick(capturedPick)
    // His pick sent as a ROUTE back to the trader (`<route>assist S</route>`) instead of the pick tag: the same name, the
    // same destination — taken as the pick, and the route dropped so the chain's hand-off carries it (the drive,
    // 2026-11-18: "I'd send S", the route not followed from his opening turn, the trader never got it). The gate below
    // still checks it is on the house's lists.
    ;({ pick, routing } = _routeAsPick(pick, routing, reply))
    if (pick && !listed.has(pick.ticker)) {
        // Not shown THIS turn — but the history keeps text only, so "another one" on a later turn picks from a list
        // read earlier. Second look: is it on the house's lists today? A failed read keeps the gate shut.
        const onLists = await houseListNames(_listDeps).catch(err => {
            logger.warn(LOG, 'the house lists were not read for the pick gate', { error: err.message })
            return new Set()
        })
        if (onLists.has(pick.ticker)) {
            logger.info(LOG, 'pick passed on the second look — on the house lists, not read this turn', { ticker: pick.ticker })
        } else {
            logger.warn(LOG, 'pick dropped — not on the house lists', { ticker: pick.ticker, listed: listed.size })
            // His prose already named it: say why no button follows, in the stream and in the saved reply.
            const dropped = pick.ticker
            pick = null
            // A pick that CAME from his route goes back to being that route — the user is still sent to the trader, with
            // their words (CR 2026-11-18). A real pick tag dropped says why no button follows.
            if (routing !== routed) routing = routed
            else {
                const note = droppedPickNote(dropped)
                onToken?.(note)
                reply += note
            }
        }
    }
    await _attachPickLabel(pick)
    // The candidates pass the same gate as the pick: on a list he was shown, or on the house's lists today.
    let candidates = _normalizeCandidates(capturedCandidates)
    if (candidates.length && candidates.some(c => !listed.has(c.ticker))) {
        const onLists = await houseListNames(_listDeps).catch(() => new Set())
        const kept = candidates.filter(c => listed.has(c.ticker) || onLists.has(c.ticker))
        if (kept.length < candidates.length) logger.warn(LOG, 'candidates dropped — not on the house lists', { dropped: candidates.filter(c => !kept.includes(c)).map(c => c.ticker) })
        candidates = kept
    }

    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasPick: !!pick, listed: listed.size, route: routing.route, phase: phase.get() })
    return { reply, phase: phase.get(), ...(pick ? { pick } : {}), ...(candidates.length ? { candidates } : {}), ...routing }
}

/** A captured <argus_candidates> — up to three distinct `{ ticker, thesis }`. Pure; exported for tests. */
export function _normalizeCandidates(raw) {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.candidates) ? raw.candidates : []
    const out = []
    for (const c of list) {
        const ticker = typeof c?.ticker === 'string' ? c.ticker.toUpperCase().trim() : ''
        if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || out.some(o => o.ticker === ticker)) continue
        out.push({ ticker, thesis: typeof c.thesis === 'string' ? c.thesis.trim().slice(0, 200) : '' })
        if (out.length >= 3) break
    }
    return out
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
/**
 * A pick sent as a route: no `<argus_pick>`, but a route back to the trader (`assist`) naming a ticker → that ticker is
 * the pick (its analysis the reply), and the route is dropped — the chain carries a pick back, a route from his opening
 * turn is never followed. A pick tag AND a route back to the trader: the route goes the same way — any route makes the
 * runner end the chain instead of carrying the pick (the drive, 2026-11-18: BBWI picked, never reached the trader).
 * Anything else is returned as it came. Pure; exported for tests.
 */
export function _routeAsPick(pick, routing, reply = '') {
    if (routing?.route !== 'assist') return { pick, routing }
    const noRoute = { ...routing, route: null, routeSymbol: null, opening: null }
    if (pick) return { pick, routing: noRoute }
    if (!routing?.routeSymbol) return { pick, routing }
    const asPick = _normalizeArgusPick({ ticker: String(routing.routeSymbol), analysis: String(reply ?? '') })
    return asPick ? { pick: asPick, routing: noRoute } : { pick, routing }
}

/** The line under a reply whose pick the gate dropped — the user read a name and gets no button. Pure. */
export function droppedPickNote(ticker) {
    return `\n\n_${ticker} is not on the house's lists today, so it can't go to the trader from here. To trade it anyway, give the trader the name yourself._`
}

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
