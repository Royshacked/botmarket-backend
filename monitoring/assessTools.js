// The tools a MONITOR reaches for when it wakes to judge a plan against live price.
//
// WHY THIS EXISTS. hermes.assess.js hand-rolls its own `_chartTool` / `_structureTools` /
// `_smcTools` / `_institutionalTools`: copies of tools that already live in
// services/agentTools.registry.js, with the TICKER REMOVED (hardcoded to the entity's own asset)
// and the timeframe clamped to an enum of the entity's ladder rungs. Talos imported those copies,
// which is why a setup could say "NVDA is weak intraday" or "SMH is leading" and the monitor had
// no way to look — not for want of a tool, but because the fork one layer down had narrowed tools
// that were already general. Same story for the handlers: `buildKairosToolHandlers` already returns
// a name→fn map, and the monitor re-implemented dispatch as a switch.
//
// So: schemas from the registry (mechanism), descriptions written here (judgment — a monitor
// VERIFYING a level is a different reader from an agent BUILDING one), handlers from the same
// shared factories every agent uses.
//
// WHAT IS THIS MODULE'S OWN: the SYMBOL SCOPE. An agent may look at anything the user asks about;
// a monitor may look only at the instruments its plan actually named. Free-text conditions can
// mention any ticker, so the fetch budget is bounded by what was authored at build rather than by
// whatever the model decides to type — see docs/desks/mentor-talos.md
//
// Shared deliberately: Talos uses it now, Hermes at the merge (Phase 5). Adding a second copy here
// is what created the problem this module fixes.

import { toolsFor } from '../services/agentTools.registry.js'
import { COMMON_TOOL_HANDLERS, makeToolHandler } from '../services/agentUtils.js'
import {
    makeQuoteHandler, makeCandlesHandler, makeEarningsHandler, makeChartHandler, makeIndicatorsHandler,
} from '../services/tools/marketData.tools.js'
import { makeStructureVisionHandler, OB_VISION, FB_VISION } from '../services/tools/priceStructure.tools.js'
import { SMC_TOOLS, SMC_TOOL_HANDLERS } from '../services/tools/smc.tools.js'
import { getPriceAction, getCycleAnalysis, getCorrelations, getQuotes } from '../providers/yahoofinance.provider.js'
import { getFundamentals } from '../providers/fmp.provider.js'
import { getSecFilings } from '../providers/sec.provider.js'
import { logger } from '../services/logger.service.js'

const LOG = '[assessTools]'

// Descriptions are the monitor's voice: every one says "you are checking a plan that already
// exists", because that is the difference between this reader and the agent that authored it.
// `show_to_user` is omitted throughout — a monitor's chart is for its own eyes; nothing it renders
// is surfaced to the user's chat (the same `omit` Argus uses, and for the same reason).
const _CHART_OMIT = { omit: ['show_to_user'] }

export const ASSESS_TOOL_SPEC = {
    get_chart: {
        description: "Render a candlestick chart IMAGE for a ticker at a timeframe and LOOK at it. Your primary read. Pull a higher timeframe for structure or a lower one for the trigger — and pull a second view when the first leaves you unsure rather than guessing.",
        ..._CHART_OMIT },
    get_candles: 'Recent OHLCV rows for a ticker at a timeframe — the exact numbers behind the chart, for when you need a level checked precisely rather than eyeballed.',
    get_quote:  'The live price for one ticker.',
    get_quotes: 'Live prices for several tickers at once — the cheap way to check on a name a condition leans on.',
    get_indicators: 'Compute indicators (ema/sma/rsi/macd/atr/vwap) for a ticker at a timeframe. This is the SAME math the plan was built on, so a condition naming a specific level ("close above ma20", "below VWAP") is verified against the same numbers rather than re-eyeballed.',
    get_price_action: 'A quick structured read of a ticker\'s recent price action — direction, range, notable moves.',
    get_orderblocks: { description: 'Structured read of the ORDER BLOCKS near current price for a ticker (last opposing candle/cluster before an impulsive break) — fresh/untested vs mitigated, zone vs price. Use it to check whether a price-action orderblock actually backs entering here.', ..._CHART_OMIT },
    get_false_breaks: { description: 'Structured read of recent FALSE BREAKS / liquidity sweeps for a ticker (price pushed beyond a prior high/low, failed, closed back inside). Use it to confirm a sweep-and-reclaim trigger.', ..._CHART_OMIT },
    get_cycle_analysis: 'The dominant recurring PRICE cycle for a ticker at a timeframe — where price sits in it now and when the next turn is due. Is a turn actually due, or are you early?',
    get_correlations: 'Correlation between tickers over a recent window — for a condition that leans on a peer or group moving together.',
    get_short_interest: 'Short interest for a ticker — short % of float, days-to-cover, month-over-month change. Has the crowding a condition rests on actually shifted? US equities only.',
    get_options_context: 'Options positioning for a ticker — put/call ratio and at-the-money implied vol. Is the directional skew still backing the plan?',
    get_derivatives_context: 'Crypto-perp positioning for a symbol — funding, open interest, long/short account ratio.',
    get_fundamentals: 'Fundamentals for a ticker — for a condition resting on the business rather than the tape.',
    get_sec_filings: 'Recent SEC filings for a ticker. Use it to confirm a filing-based condition actually landed, rather than assuming.',
    get_earnings: 'Reported and upcoming earnings for a ticker.',
    // The only way to check a condition about the WORLD ("the FDA approval has landed"). Server-side:
    // Anthropic runs it, so there is no handler and no symbol scope to enforce.
    web_search: '',
}

/** The tool LIST a monitor sees. SMC tools have their own home and are spread, not re-declared. */
export function buildAssessTools() {
    return [...toolsFor(ASSESS_TOOL_SPEC), ...SMC_TOOLS]
}

// The handler map. `onChart: null` throughout — a monitor never surfaces a chart to the user's
// chat, so the image stays model-only.
const _HANDLERS = {
    ...SMC_TOOL_HANDLERS,
    ...COMMON_TOOL_HANDLERS,
    get_quote:      makeQuoteHandler(LOG),
    get_candles:    makeCandlesHandler(LOG),
    get_earnings:   makeEarningsHandler(LOG),
    get_indicators: makeIndicatorsHandler(LOG),
    get_chart: makeChartHandler({
        log: LOG, onChart: null,
        readText: 'Read the price STRUCTURE first — swing highs/lows, prior-day levels, orderblocks, sweeps, reclaims. Indicators confirm; they are not the trigger.',
    }),
    get_orderblocks:  makeStructureVisionHandler({ log: LOG, kind: 'orderblocks',  vision: OB_VISION, onChart: null }),
    get_false_breaks: makeStructureVisionHandler({ log: LOG, kind: 'false_breaks', vision: FB_VISION, onChart: null }),

    get_quotes: makeToolHandler('get_quotes',
        ({ tickers }) => getQuotes(Array.isArray(tickers) ? tickers : [tickers]),
        (err, { tickers }) => `Could not fetch quotes for ${tickers}: ${err.message}`, LOG),
    get_price_action: makeToolHandler('get_price_action',
        ({ ticker }) => getPriceAction(ticker),
        (err, { ticker }) => `Could not fetch price action for ${ticker}: ${err.message}`, LOG),
    get_cycle_analysis: makeToolHandler('get_cycle_analysis',
        ({ ticker, timeframe }) => getCycleAnalysis(ticker, timeframe),
        (err, { ticker }) => `Could not read the cycle for ${ticker}: ${err.message}`, LOG),
    get_correlations: makeToolHandler('get_correlations',
        ({ tickers }) => getCorrelations(Array.isArray(tickers) ? tickers : [tickers]),
        (err, { tickers }) => `Could not compute correlations for ${tickers}: ${err.message}`, LOG),
    get_fundamentals: makeToolHandler('get_fundamentals',
        ({ ticker }) => getFundamentals(ticker),
        (err, { ticker }) => `Could not fetch fundamentals for ${ticker}: ${err.message}`, LOG),
    get_sec_filings: makeToolHandler('get_sec_filings',
        ({ ticker }) => getSecFilings(ticker),
        (err, { ticker }) => `Could not fetch filings for ${ticker}: ${err.message}`, LOG),
}

// Every argument name a tool uses to say "which instrument". Checked as a set rather than
// per-tool so a newly-mounted tool cannot quietly escape the scope by spelling it differently.
const _SYMBOL_ARGS = ['ticker', 'symbol', 'tickers', 'symbols']

/**
 * The symbols a call is asking about, upper-cased. Pure.
 */
export function requestedSymbols(input) {
    const out = []
    for (const key of _SYMBOL_ARGS) {
        const v = input?.[key]
        if (typeof v === 'string' && v.trim()) out.push(v.toUpperCase().trim())
        else if (Array.isArray(v)) out.push(...v.filter(s => typeof s === 'string' && s.trim()).map(s => s.toUpperCase().trim()))
    }
    return out
}

/**
 * Build the tool-use runner for one entity.
 *
 * `symbols` is the WHOLE allowed universe for this wake — the entity's own asset plus whatever it
 * declared it leans on. A call naming anything else comes back as an error tool_result rather than
 * a fetch, so the model is told (and can carry on, marking the condition `unchecked`) instead of
 * silently pulling data the plan never authorised.
 *
 * NOTE what is deliberately NOT enforced: the timeframe. The old handler rejected any rung outside
 * the entity's ±2 ladder window, which made "NVDA weak INTRADAY" unverifiable on a swing setup —
 * the ladder is the suggested primary view, not a fence.
 *
 * `onCall(name)` fires per executed tool, so the wake can record what it actually spent. With no
 * round cap in dev, that record IS the cost control: measure first, then set the ceiling.
 */
export function makeAssessToolRunner({ symbols = [], log = LOG, onCall = null, handlers = _HANDLERS } = {}) {
    const allowed = new Set(symbols.filter(Boolean).map(s => String(s).toUpperCase().trim()))

    const _err = (id, content) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content })

    return async function runToolUses(assistantContent) {
        // `server_tool_use` (web_search) is Anthropic's to run — it never reaches here, which is
        // also why the symbol scope cannot apply to it.
        const uses = (assistantContent ?? []).filter(b => b?.type === 'tool_use')
        const results = []

        for (const use of uses) {
            const input = use.input ?? {}

            const outOfScope = requestedSymbols(input).filter(s => !allowed.has(s))
            if (outOfScope.length) {
                logger.info(log, `blocked out-of-scope read: ${use.name} → ${outOfScope.join(', ')}`)
                results.push(_err(use.id,
                    `${outOfScope.join(', ')} is not in this plan's scope. You may only read: ${[...allowed].join(', ')}. ` +
                    `If a condition depends on a symbol outside that list, mark it "unchecked" and say which symbol was missing.`))
                continue
            }

            const fn = handlers[use.name]
            if (!fn) {
                results.push(_err(use.id, `unknown tool "${use.name}"`))
                continue
            }

            try { onCall?.(use.name) } catch { /* accounting must never break a read */ }

            // The shared factories wrap every handler in makeToolHandler, which catches and returns
            // a readable error string — so a failed provider becomes a tool_result the model can
            // act on ("mark it unchecked") rather than an exception that loses the whole wake.
            const out = await fn(input)
            results.push({ type: 'tool_result', tool_use_id: use.id, content: Array.isArray(out) ? out : String(out) })
        }
        return results
    }
}

export const _testHandlers = _HANDLERS
