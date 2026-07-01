import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { callAnthropicWithTools } from '../providers/anthropic.provider.js'
import { resolveStreamFn, DEFAULT_MODEL } from './llmModels.js'
import { recordUsage } from './tokenUsage.service.js'
import { getQuote, getTickerAggregates, getEarnings } from '../providers/yahoofinance.provider.js'
import { getSecFilings } from '../providers/sec.provider.js'
import { fetchChartImage } from '../providers/chartImg.provider.js'
import { buildStudies } from '../monitoring/evaluators/chart.evaluator.js'
import { logger } from './logger.service.js'
import { toolError } from './toolResult.util.js'
import { normalizeTimeframe } from './timeframe.service.js'
import { normalizeTreeNode, firstLeafTimeframe } from './conditionTree.service.js'
import { cleanConviction } from './conviction.util.js'
import { COMMON_TOOL_HANDLERS, makePromptLoader, buildAccountLines } from './agentUtils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = join(__dirname, '../trade_assistant_system_prompt.md')

const LOG = '[tradeAgent]'

// Load the system prompt fresh when the file changes (mtime-gated), so prompt
// edits take effect on the next request without a server restart.
const _baseSystemPrompt = makePromptLoader(PROMPT_PATH, LOG)
const MAX_RECENT_MESSAGES = 6

const TOOLS = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
        name: 'get_quote',
        description: 'Get the current real-time price quote for a stock ticker. Call this when the user asks about current price, today\'s levels, or when you need live price data to answer accurately.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'Stock ticker symbol e.g. AAPL, NVDA' },
            },
            required: ['ticker'],
        },
    },
    {
        name: 'get_candles',
        description: 'Fetch recent OHLCV candles for a ticker. Use this whenever the user asks about orderblocks, support/resistance, chart patterns, price levels, or any question that requires seeing recent price action. Never say you cannot see live data — call this tool first.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: {
                    type: 'string',
                    description: 'Stock ticker symbol e.g. AAPL, NVDA',
                },
                timeframe: {
                    type: 'string',
                    enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'],
                    description: 'Candle timeframe. 2hr and 4hr are aggregated server-side from native 1hr bars into true 2hr/4hr OHLCV (Yahoo has no native 2hr/4hr); every other resolution is a native interval. Sub-hour history is limited (1min ~5 days, 5/15/30min ~weeks) — match the timeframe to the setup.',
                },
            },
            required: ['ticker', 'timeframe'],
        },
    },
    {
        name: 'get_earnings',
        description: 'Upcoming earnings date + EPS estimate for a ticker, plus the last 4 quarterly EPS actuals vs estimates (with surprise %). Use this in early formation when checking if there is a catalyst coming up, whether to hold through earnings, or whether the company has a history of beating/missing. US equities only — no ETFs, crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'e.g. AAPL, NVDA, TSLA' },
            },
            required: ['ticker'],
        },
    },
    {
        name: 'get_sec_filings',
        description: 'Recent earnings-relevant SEC filings for a US-listed equity: latest 8-K (flagging item 2.02 earnings releases), 10-Q and 10-K with filing dates and document links. Use when the user wants to dig into what was actually reported — guidance, material events, or any red flags in recent filings. US equities only (EDGAR filers); not for ETFs, crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'e.g. AAPL, NVDA, TSLA' },
            },
            required: ['ticker'],
        },
    },
    {
        name: 'get_chart',
        description: 'Render an actual TradingView candlestick chart IMAGE (with indicator overlays) and look at it directly, for VISUAL / structural analysis — chart patterns, trendlines, support/resistance, orderblocks, where price sits relative to moving averages. Renders native 4hr candles. For EXACT numeric levels (precise entry/stop/TP prices) prefer get_candles. ONLY call this once the conversation is about building or refining a concrete trade setup on a SINGLE asset — i.e. you are defining or validating an entry, stop, or take-profit, or confirming the market structure behind that setup. Do NOT call it while scanning / screening for stocks, comparing multiple tickers, or answering general questions about a stock; use get_quote / get_candles / web_search for that. One asset, setup stage only.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: {
                    type: 'string',
                    description: 'Ticker symbol e.g. AAPL, NVDA, BTCUSDT',
                },
                timeframe: {
                    type: 'string',
                    enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'],
                    description: 'Chart timeframe. All resolutions render natively via TradingView.',
                },
                indicators: {
                    type: 'string',
                    description: 'Optional free-text indicators to overlay, e.g. "rsi(14), ema(50), volume, vwap". Leave empty for sensible defaults (EMA 20/50).',
                },
                show_to_user: {
                    type: 'boolean',
                    description: 'Set true whenever this chart relates to the user\'s ACTUAL setup — you are defining, validating, or refining their entry / stop / take-profit or reading the market structure behind it, or they asked to see it. In those cases the user wants to see what you are looking at, so show it. Leave false / omit ONLY for a quick throwaway internal peek that does not inform the setup under discussion; such a check must NOT appear in the chat.',
                },
            },
            required: ['ticker', 'timeframe'],
        },
    },
    {
        name: 'get_short_interest',
        description: 'Short interest for a US-listed single stock/ADR: short % of float, days-to-cover (short ratio), and month-over-month change. FINRA data, reported bi-monthly with a ~2-week lag — use it for squeeze potential and crowded-bearish positioning when building or pressure-testing a thesis, not as a live read. No data for ETFs, crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. GME, TSLA, AAPL' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_options_context',
        description: 'Options positioning for a US equity/ETF: put/call ratio (by open interest and by volume) and at-the-money implied volatility for the nearest expiry. Use it to read directional skew and how big a move the market is pricing (elevated IV = expensive options / large expected move, often around a catalyst — relevant for entry timing and event risk). Quotes ~15-min delayed. No data for crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. NVDA, SPY, AAPL' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_derivatives_context',
        description: 'Crypto-perp positioning from Binance: funding rate (who pays to hold the trade — a crowding signal), open interest (committed leverage), and the global long/short account ratio (retail skew). This is the crypto analog to short-interest/options sentiment — use it when the setup is on a crypto perp. Crypto perps only (BTC, ETH, SOL…), not equities, FX or traditional futures.',
        input_schema: {
            type: 'object',
            properties: { symbol: { type: 'string', description: 'e.g. BTC, ETH, SOL (or BTC-USD / BTCUSDT)' } },
            required: ['symbol'],
        },
        cache_control: { type: 'ephemeral' },
    },
]

// Per timeframe: Yahoo bar spec + how many candles to return + lookback window.
// `aggregate` (2hr/4hr) means fetch native 1hr bars and combine N→1 server-side,
// since Yahoo has no native 2hr/4hr. windowDays respects Yahoo's intraday history
// limits (1min ≤ 7d, 5/15/30min ≤ 60d, 1hr ≤ 730d); extra lookback is just sliced
// off, so it only needs to be a safe upper bound that captures `count` bars.
const _CANDLE_CFG = {
    '1min':  { timeSpan: 'minute', multiplier: 1,  count: 60, windowDays: 5   },
    '5min':  { timeSpan: 'minute', multiplier: 5,  count: 60, windowDays: 10  },
    '15min': { timeSpan: 'minute', multiplier: 15, count: 50, windowDays: 20  },
    '30min': { timeSpan: 'minute', multiplier: 30, count: 40, windowDays: 40  },
    '1hr':   { timeSpan: 'hour',   multiplier: 1,  count: 30, windowDays: 5   },
    '2hr':   { timeSpan: 'hour',   multiplier: 1,  count: 30, windowDays: 16, aggregate: 2 },
    '4hr':   { timeSpan: 'hour',   multiplier: 1,  count: 24, windowDays: 24, aggregate: 4 },
    'day':   { timeSpan: 'day',    multiplier: 1,  count: 40, windowDays: 60  },
    'week':  { timeSpan: 'week',   multiplier: 1,  count: 24, windowDays: 200 },
    'month': { timeSpan: 'month',  multiplier: 1,  count: 24, windowDays: 800 },
}

function _fmtVol(v) {
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
    if (v >= 1_000)     return (v / 1_000).toFixed(0) + 'K'
    return String(v)
}

// Yahoo offers no native 2hr/4hr interval, so get_candles fetches 1hr bars and
// aggregates them into true 2hr/4hr OHLCV here — deterministic and exact, rather
// than asking the model to mentally group 1hr rows. Groups are aligned to end
// on the newest bar (any oldest partial group is dropped).
function _aggregateCandles(rows, groupSize) {
    if (!Array.isArray(rows) || rows.length === 0) return []
    const rem     = rows.length % groupSize
    const aligned = rem ? rows.slice(rem) : rows
    const out = []
    for (let i = 0; i < aligned.length; i += groupSize) {
        const grp = aligned.slice(i, i + groupSize)
        out.push({
            timestamp: grp[0].timestamp,
            open:      grp[0].open,
            high:      Math.max(...grp.map(c => c.high)),
            low:       Math.min(...grp.map(c => c.low)),
            close:     grp[grp.length - 1].close,
            volume:    grp.reduce((s, c) => s + (c.volume || 0), 0),
        })
    }
    return out
}

const TOOL_HANDLERS = {
    get_quote: async ({ ticker }) => {
        try {
            return await getQuote(ticker)
        } catch (err) {
            logger.warn(LOG, `get_quote failed for ${ticker}:`, err.message)
            return toolError(`Could not fetch quote for ${ticker}: ${err.message}`)
        }
    },

    get_candles: async ({ ticker, timeframe }) => {
        try {
            const cfg  = _CANDLE_CFG[timeframe] ?? _CANDLE_CFG['day']
            const from = Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000
            const raw  = await getTickerAggregates(ticker.toUpperCase(), { timeSpan: cfg.timeSpan, multiplier: cfg.multiplier, from })
            // Yahoo has no native 2hr/4hr — fetch 1hr bars and aggregate N→1 here
            // so the LLM reads real OHLCV, not hand-grouped rows.
            const bars = cfg.aggregate ? _aggregateCandles(raw, cfg.aggregate) : raw
            const rows = bars.slice(-cfg.count)
            if (rows.length === 0) return toolError(`No candle data available for ${ticker}`)

            const header = `${ticker.toUpperCase()} ${timeframe} — ${rows.length} candles, newest last:\n`
            const lines  = rows.map(c => {
                const d = new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
                return `${d}  O:${c.open.toFixed(2)}  H:${c.high.toFixed(2)}  L:${c.low.toFixed(2)}  C:${c.close.toFixed(2)}  V:${_fmtVol(c.volume)}`
            })
            return header + lines.join('\n')
        } catch (err) {
            logger.warn(LOG, `get_candles failed for ${ticker}:`, err.message)
            return toolError(`Could not fetch candles for ${ticker}: ${err.message}`)
        }
    },

    get_earnings: async ({ ticker }) => {
        try {
            return await getEarnings(ticker)
        } catch (err) {
            logger.warn(LOG, `get_earnings failed for ${ticker}:`, err.message)
            return toolError(`Could not fetch earnings for ${ticker}: ${err.message}`)
        }
    },

    get_sec_filings: async ({ ticker }) => {
        try {
            return await getSecFilings(ticker)
        } catch (err) {
            logger.warn(LOG, `get_sec_filings failed for ${ticker}:`, err.message)
            return toolError(`Could not fetch SEC filings for ${ticker}: ${err.message}`)
        }
    },

    ...COMMON_TOOL_HANDLERS,
}

// ─── Chart image (vision) ─────────────────────────────────────────────────────
// get_chart renders an actual TradingView chart and hands it to the LLM as an
// image so the agent can do true visual TA (patterns, structure, indicator
// geometry) instead of eyeballing OHLCV rows. Renders are cached briefly by
// symbol+timeframe+studies — chart-img is paid / rate-limited and the agent may
// request the same view repeatedly (e.g. internal check, then again to show it).
const _chartCache  = new Map()   // key -> { at, png }
const CHART_TTL_MS = 60 * 1000   // intraday views go stale fast; 60s is plenty within a chat

async function _cachedChartImage(symbol, timeframe, studies) {
    const key = `${symbol}|${timeframe}|${studies.map(s => s.name).join(',')}`
    const hit = _chartCache.get(key)
    if (hit && Date.now() - hit.at < CHART_TTL_MS) return hit.png
    const png = await fetchChartImage(symbol, timeframe, studies)
    if (_chartCache.size > 100) _chartCache.clear()
    _chartCache.set(key, { at: Date.now(), png })
    return png
}

// Build the per-request tool handler map. The static handlers (get_quote /
// get_candles) are shared; get_chart closes over onChart so it can surface the
// rendered chart to the user's chat when the agent flags show_to_user. Pass
// onChart = null (non-stream path or non-Anthropic provider) to keep get_chart
// model-only — the image still reaches the LLM, it just isn't shown to the user.
function _buildToolHandlers(onChart) {
    return {
        ...TOOL_HANDLERS,
        get_chart: async ({ ticker, timeframe, indicators = '', show_to_user = false }) => {
            try {
                const symbol  = String(ticker || '').toUpperCase()
                const studies = buildStudies(indicators || '')
                const png     = await _cachedChartImage(symbol, timeframe, studies)

                if (show_to_user && typeof onChart === 'function') {
                    try { onChart({ symbol, timeframe, imageBase64: png }) }
                    catch (err) { logger.warn(LOG, 'onChart emit failed:', err.message) }
                }

                const studyNames = studies.map(s => s.name).join(', ') || 'EMA20/50'
                return [
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
                    { type: 'text',  text: `${symbol} ${timeframe} TradingView chart (studies: ${studyNames}). Analyze the price structure visually.` },
                ]
            } catch (err) {
                logger.warn(LOG, `get_chart failed for ${ticker}/${timeframe}:`, err.message)
                return toolError(`Could not render chart for ${ticker}: ${err.message}. Use get_candles instead.`)
            }
        },
    }
}

export const tradeAgentService = {
    chat,
    chatStream,
}

async function chat({ messages, userPrompt, analysisState = emptyAnalysisState(), brokerContext = null }) {
    const systemPrompt = _buildSystemPrompt(analysisState, brokerContext)
    const builtMessages = _buildMessages({ messages, userPrompt, analysisState })

    logger.info(LOG, 'chat start', {
        userPrompt,
        messageCount: builtMessages.length,
        activeAsset: analysisState?.structured_state?.active_asset ?? '',
    })

    const raw = await callAnthropicWithTools({
        model: DEFAULT_MODEL,
        promptOrMessages: builtMessages,
        systemPrompt,
        tools: TOOLS,
        toolHandlers: _buildToolHandlers(null),   // non-stream: chart goes to the LLM only, not the UI
    })

    const { reply, updatedState, tradeIdea } = _parseResponse(raw, analysisState, userPrompt)

    logger.info(LOG, 'chat done', {
        replyLength: reply.length,
        hasTradeIdea: Boolean(tradeIdea),
        recentMessageCount: updatedState.recent_messages.length,
    })

    return { reply, analysisState: updatedState, ...(tradeIdea ? { tradeIdea } : {}) }
}

async function chatStream({ messages, userPrompt, analysisState = emptyAnalysisState(), brokerContext = null, ideaAccounts = [], model: requestedModel, reasoningEffort, userId, onToken, onAsset, onInterval, onChart, onPhase, onToolStart, onReasoning, signal }) {
    const { model, streamFn, provider } = resolveStreamFn(requestedModel)

    // get_chart returns an image tool_result, which only the Anthropic provider
    // renders — gate the tool (and its UI emit) to Anthropic so other providers
    // never receive an image block they can't handle. The prompt is told the
    // tool is absent (hasChartTool) so it doesn't instruct the model to call it.
    const isAnthropic = provider === 'anthropic'
    const tools        = isAnthropic ? TOOLS : TOOLS.filter(t => t.name !== 'get_chart')
    const toolHandlers = _buildToolHandlers(isAnthropic ? onChart : null)

    const systemPrompt   = _buildSystemPrompt(analysisState, brokerContext, ideaAccounts, { hasChartTool: isAnthropic })
    const builtMessages  = _buildMessages({ messages, userPrompt, analysisState })

    logger.info(LOG, 'chatStream start', {
        userPrompt,
        messageCount:  builtMessages.length,
        activeAsset:   analysisState?.structured_state?.active_asset ?? '',
        model,
        provider,
    })

    const onUsage = userId ? (usage) => recordUsage(userId, model, usage).catch(() => {}) : undefined

    let capturedPhase = null

    const onPhaseCapture = (p) => {
        const n = parseInt(p, 10)
        if (n >= 1 && n <= 5) {
            capturedPhase = n
            onPhase?.(n)
        }
    }

    // Tag capture set for the tag suppressor — same tags/order the positional
    // suppressor produced for this agent (state, trade_idea, asset, interval,
    // phase, portfolio_mandate, portfolio_thesis — the last two suppress-only).
    const tagCaptures = [
        { open: '<state>',             close: '</state>',             onCapture: null           },
        { open: '<trade_idea>',        close: '</trade_idea>',        onCapture: null           },
        { open: '<asset>',             close: '</asset>',             onCapture: onAsset        },
        { open: '<interval>',          close: '</interval>',          onCapture: onInterval     },
        { open: '<phase>',             close: '</phase>',             onCapture: onPhaseCapture  },
        { open: '<portfolio_mandate>', close: '</portfolio_mandate>', onCapture: null           },
        { open: '<portfolio_thesis>',  close: '</portfolio_thesis>',  onCapture: null           },
    ]

    const raw = await streamFn({
        model,
        promptOrMessages: builtMessages,
        systemPrompt,
        tools,
        toolHandlers,
        reasoningEffort,
        signal,
        onToken,
        tagCaptures,
        onToolStart,
        onReasoning,
        onUsage,
    })

    const { reply, updatedState, tradeIdea } = _parseResponse(raw, analysisState, userPrompt)

    logger.info(LOG, 'chatStream done', {
        replyLength:       reply.length,
        hasTradeIdea:      Boolean(tradeIdea),
        recentMessageCount: updatedState.recent_messages.length,
        phase: capturedPhase,
    })

    return { reply, analysisState: updatedState, phase: capturedPhase, ...(tradeIdea ? { tradeIdea } : {}) }
}

function _buildSystemPrompt(analysisState, brokerContext, ideaAccounts = [], { hasChartTool = true } = {}) {
    const asset   = analysisState?.structured_state?.active_asset || 'none'
    const summary = analysisState?.recent_chat_summary || 'No prior context.'
    const pt      = analysisState?.structured_state?.pending_trade

    // Include the current pending_trade so the LLM updates from it rather than
    // re-deriving the entire state from scratch each turn.
    const stateSection = pt
        ? `\nCurrent pending trade (carry all set fields forward — only update what changed):\n${JSON.stringify(pt, null, 2)}`
        : ''

    // get_chart is only wired on the Anthropic provider; on others it's stripped
    // from the tool list. Neutralize the base prompt's get_chart instructions
    // here (volatile tail) so the model isn't told to call a tool it lacks.
    const chartNote = hasChartTool
        ? ''
        : '\n\nNOTE: get_chart is NOT available in this session — ignore every instruction above about rendering or looking at a chart image. Do your visual/structural read from get_candles and web_search instead, and never claim to see a chart.'

    // Split into a stable base (the instructions — byte-identical every request)
    // and a volatile context tail. cache_control on the base lets Anthropic cache
    // the tools+instructions prefix across turns (and across users), so only the
    // short tail is reprocessed each request. Returned as system content blocks;
    // the OpenAI provider flattens this array back to a plain string.
    const dynamicContext = `---
CONVERSATION CONTEXT:
${summary}
Active asset: ${asset}${stateSection}${_buildBrokerSection(brokerContext)}${_buildIdeaAccountsSection(ideaAccounts)}${chartNote}`

    return [
        { type: 'text', text: _baseSystemPrompt(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicContext },
    ]
}

function _buildBrokerSection(brokerContext) {
    if (!brokerContext || typeof brokerContext !== 'object') return ''
    const entries = Object.entries(brokerContext).filter(([, d]) => d?.account)
    if (entries.length === 0) return ''

    const lines = entries.map(([type, { account, positions }]) => {
        const cur  = account.currency || ''
        const fmt  = (v) => v != null ? `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'
        const pct  = (v) => v != null ? `${Number(v).toFixed(0)}%` : '—'
        let line = `${type} (${cur}): Balance ${fmt(account.balance)} | Equity ${fmt(account.equity)} | Free margin ${fmt(account.freeMargin)} | Margin level ${pct(account.marginLevel)}`

        if (Array.isArray(positions) && positions.length > 0) {
            const pos = positions.map(p => {
                const pnl = p.pnl != null ? ` P&L: ${p.pnl >= 0 ? '+' : ''}${fmt(p.pnl)}` : ''
                return `  - ${p.symbol} ${p.direction} ${p.volume ?? '?'} @ ${p.entryPrice ?? '?'}${pnl}`
            }).join('\n')
            line += `\n  Open positions:\n${pos}`
        } else {
            line += '\n  No open positions'
        }
        return line
    })

    return `\n\nBROKER ACCOUNT:\n${lines.join('\n\n')}`
}

function _buildIdeaAccountsSection(accounts) {
    if (!Array.isArray(accounts) || accounts.length === 0) return ''
    const lines = buildAccountLines(accounts)
    return `\n\nIDEA ACCOUNTS (the user plans to execute this trade on):\n${lines.join('\n')}`
}

function _buildMessages({ messages, userPrompt, analysisState }) {
    const prior = Array.isArray(analysisState?.recent_messages) ? analysisState.recent_messages : []

    if (Array.isArray(messages) && messages.length > 0) {
        const normalized = messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
            .map(({ role, content }) => ({ role, content: content.trim() }))
        // Caller owns the history — don't prepend prior to avoid duplicating messages
        // that are already present in the messages array.
        return _trimMessages(normalized)
    }

    const current = userPrompt?.trim()
        ? [{ role: 'user', content: userPrompt.trim() }]
        : []
    return _trimMessages([...prior, ...current])
}

function _parseResponse(raw, priorState, userPrompt) {
    let text = raw ?? ''
    let tradeIdea = null
    let updatedState = null


    text = text.replace(/<asset>[\s\S]*?<\/asset>/, '').trim()
    text = text.replace(/<phase>[\s\S]*?<\/phase>/, '').trim()

    const tradeMatch = text.match(/<trade_idea>([\s\S]*?)<\/trade_idea>/)
    if (tradeMatch) {
        try {
            tradeIdea = JSON.parse(tradeMatch[1].trim())
            // Normalise timeframes in all condition tree nodes
            if (tradeIdea) {
                const entryTf = firstLeafTimeframe(tradeIdea.entry_condition) ?? null
                tradeIdea.entry_condition = normalizeTreeNode(tradeIdea.entry_condition, entryTf)
                tradeIdea.stop_loss       = normalizeTreeNode(tradeIdea.stop_loss,       entryTf)
                tradeIdea.take_profit     = normalizeTreeNode(tradeIdea.take_profit,     entryTf)
            }
        } catch {
            logger.warn(LOG, 'trade_idea parse failed', { raw: tradeMatch[1] })
        }
        text = text.replace(/<trade_idea>[\s\S]*?<\/trade_idea>/, '').trim()
    }

    const stateMatch = text.match(/<state>([\s\S]*?)<\/state>/)
    if (stateMatch) {
        try {
            updatedState = JSON.parse(stateMatch[1].trim())
        } catch (err) {
            logger.warn(LOG, 'state parse failed', { raw: stateMatch[1], err: err.message })
        }
        text = text.replace(/<state>[\s\S]*?<\/state>/, '').trim()
    }

    if (!updatedState || !_isValidState(updatedState)) {
        updatedState = _fallbackState(priorState, userPrompt, text)
    } else {
        // recent_messages is tracked backend-side, not emitted by the LLM — it was
        // pure output-token waste to have the model retype the conversation verbatim
        // every turn. Build it here from prior history + this turn's user/assistant
        // exchange (same logic as _fallbackState).
        updatedState.recent_messages = _buildRecentMessages(priorState, userPrompt, text)
        const pt      = updatedState.structured_state.pending_trade
        const priorPt = priorState?.structured_state?.pending_trade

        logger.info(LOG, 'parsed pending_trade', JSON.stringify({
            entry_timeframe:  pt?.entry_timeframe,
            stop_timeframe:   pt?.stop_timeframe,
            tp_timeframe:     pt?.tp_timeframe,
            entry_cond_count: pt?.entry_conditions?.length,
            first_entry_tf:   pt?.entry_conditions?.[0]?.timeframe,
        }))

        // if the LLM omitted pending_trade entirely, keep the prior values
        if (!pt && priorPt) {
            updatedState.structured_state.pending_trade = priorPt
        } else if (pt) {
            // ── Migrate old flat 'timeframe' field → entry_timeframe ──────────────
            if (pt.timeframe && !pt.entry_timeframe) {
                pt.entry_timeframe = normalizeTimeframe(pt.timeframe)
            }
            delete pt.timeframe   // always remove — never send old field back to LLM

            // Normalise group-level TF fields
            pt.entry_timeframe = normalizeTimeframe(pt.entry_timeframe) || normalizeTimeframe(priorPt?.entry_timeframe) || null
            pt.stop_timeframe  = normalizeTimeframe(pt.stop_timeframe)  || null
            pt.tp_timeframe    = normalizeTimeframe(pt.tp_timeframe)    || null

            // Normalise per-condition timeframe strings (LLM often writes "15m", "4 hours", etc.)
            pt.entry_conditions = _normalizeConditions(pt.entry_conditions)
            pt.stop_conditions  = _normalizeConditions(pt.stop_conditions)
            pt.tp_conditions    = _normalizeConditions(pt.tp_conditions)

            // Best available entry TF: condition-level → group-level → prior group-level → prior condition-level
            const entryTf = pt.entry_conditions[0]?.timeframe
                || pt.entry_timeframe
                || priorPt?.entry_timeframe
                || priorPt?.entry_conditions?.[0]?.timeframe
                || normalizeTimeframe(priorPt?.timeframe)   // migrate prior old-format too
                || null

            // Backfill group-level TF if LLM omitted it
            if (!pt.entry_timeframe) pt.entry_timeframe = entryTf

            // Carry forward per-condition timeframes from prior state if LLM omitted them
            _fillMissingTimeframes(pt.entry_conditions, priorPt?.entry_conditions, entryTf)
            _fillMissingTimeframes(pt.stop_conditions,  priorPt?.stop_conditions,  pt.stop_timeframe  ?? entryTf)
            _fillMissingTimeframes(pt.tp_conditions,    priorPt?.tp_conditions,    pt.tp_timeframe    ?? entryTf)

            // Carry forward logic operators — default AND/OR if LLM omitted them
            pt.entry_logic = pt.entry_logic || priorPt?.entry_logic || 'AND'
            pt.stop_logic  = pt.stop_logic  || priorPt?.stop_logic  || 'OR'
            pt.tp_logic    = pt.tp_logic    || priorPt?.tp_logic    || 'OR'

            // Carry forward quantity
            if (pt.quantity == null && priorPt?.quantity != null) pt.quantity = priorPt.quantity
            if (pt.quantity != null) pt.quantity = Number(pt.quantity) || null

            // Carry forward conviction — once the model has judged the setup, keep
            // that assessment on later turns where it re-emits pending_trade without
            // re-stating it (very common). cleanConviction nulls a malformed block;
            // fall back to the prior good one so the chip/rationale don't flicker out.
            pt.conviction = cleanConviction(pt.conviction) || cleanConviction(priorPt?.conviction) || null

            // Normalise additional entries
            if (!Array.isArray(pt.additional_entries)) {
                pt.additional_entries = priorPt?.additional_entries ?? []
            } else {
                pt.additional_entries = pt.additional_entries.map(ae => ({
                    conditions: _normalizeConditions(ae.conditions),
                    logic:      ae.logic ?? 'AND',
                    quantity:   ae.quantity != null ? Number(ae.quantity) || null : null,
                }))
            }
        }
    }

    return { reply: text, updatedState, tradeIdea }
}

function _isValidState(state) {
    return (
        state &&
        typeof state === 'object' &&
        typeof state.recent_chat_summary === 'string' &&
        state.structured_state &&
        typeof state.structured_state === 'object'
    )
}

// Build the rolling chat history backend-side from prior history + this turn's
// exchange. The LLM no longer emits recent_messages (saves premium output tokens).
function _buildRecentMessages(priorState, userPrompt, replyText) {
    return _trimMessages([
        ...(priorState?.recent_messages ?? []),
        ...(userPrompt?.trim() ? [{ role: 'user', content: userPrompt.trim() }] : []),
        ...(replyText?.trim() ? [{ role: 'assistant', content: replyText.trim() }] : []),
    ])
}

function _fallbackState(priorState, userPrompt, replyText) {
    const prior = priorState && typeof priorState === 'object' ? priorState : emptyAnalysisState()
    const recent_messages = _buildRecentMessages(prior, userPrompt, replyText)
    return {
        recent_messages,
        recent_chat_summary: prior.recent_chat_summary ?? '',
        // preserve the full prior structured_state — never wipe trade params on fallback
        structured_state: prior.structured_state ?? emptyAnalysisState().structured_state,
    }
}

function _trimMessages(messages) {
    if (!Array.isArray(messages)) return []
    return messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content.trim() }))
        .slice(-MAX_RECENT_MESSAGES)
}

// ─── Condition normalisation ──────────────────────────────────────────────────

function _normalizeConditions(arr) {
    if (!Array.isArray(arr)) return []
    return arr.map(c => {
        if (typeof c === 'string') return { condition: c, type: 'structured', timeframe: null }
        return { ...c, timeframe: normalizeTimeframe(c.timeframe) }
    })
}

/**
 * For each condition that is missing a timeframe, try to fill it from:
 * 1. The matching prior-state condition at the same index
 * 2. The defaultTf (entry TF) as the final fallback
 */
function _fillMissingTimeframes(conditions, priorConditions, defaultTf) {
    if (!Array.isArray(conditions)) return
    conditions.forEach((c, i) => {
        if (!c.timeframe) {
            c.timeframe = priorConditions?.[i]?.timeframe || defaultTf || null
        }
    })
}

export function emptyAnalysisState() {
    return {
        recent_messages: [],
        recent_chat_summary: '',
        structured_state: {
            active_asset: '',
            pending_trade: {
                direction: null,
                type:      null,
                asset_class: null,   // 'stock'|'etf'|'futures'|'forex'|'crypto' — set by the LLM from context
                quantity:  null,
                entry_timeframe: null,  // set as soon as user mentions a TF, even before conditions
                stop_timeframe: null,   // null = inherit entry_timeframe
                tp_timeframe: null,     // null = inherit entry_timeframe
                entry_logic: 'AND',
                entry_conditions: [],       // [{ condition, type, timeframe }]
                stop_logic: 'OR',
                stop_conditions: [],        // [{ condition, type, timeframe }]
                tp_logic: 'OR',
                tp_conditions: [],          // [{ condition, type, timeframe }]
                additional_entries: [],     // [{ conditions, logic, quantity }]
                notes: null,
            },
        },
    }
}
