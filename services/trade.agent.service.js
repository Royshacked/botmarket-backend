import { readFileSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { callAnthropicWithTools } from '../providers/anthropic.provider.js'
import { resolveStreamFn } from './llmModels.js'
import { getQuote, getTickerAggregates } from '../providers/yahoofinance.provider.js'
import { fetchChartImage } from '../providers/chartImg.provider.js'
import { buildStudies } from '../monitoring/evaluators/chart.evaluator.js'
import { logger } from './logger.service.js'
import { normalizeTimeframe } from './timeframe.service.js'
import { normalizeTreeNode, firstLeafTimeframe } from './conditionTree.service.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = join(__dirname, '../trade_assistant_system_prompt.md')

const LOG = '[tradeAgent]'

// Load the system prompt fresh when the file changes (mtime-gated), so prompt
// edits take effect on the next request without a server restart. The read is
// skipped when the file is unchanged, so the steady-state cost is one statSync.
let _promptCache = { mtimeMs: 0, text: '' }
function _baseSystemPrompt() {
    try {
        const { mtimeMs } = statSync(PROMPT_PATH)
        if (mtimeMs !== _promptCache.mtimeMs) {
            _promptCache = { mtimeMs, text: readFileSync(PROMPT_PATH, 'utf-8') }
            logger.info(LOG, 'System prompt (re)loaded')
        }
    } catch (err) {
        if (!_promptCache.text) throw err   // first load must succeed — surface it
        logger.warn(LOG, `prompt reload failed, using cached copy: ${err.message}`)
    }
    return _promptCache.text
}
const MODEL = 'claude-sonnet-4-6'   // non-streaming chat() path only
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
                    enum: ['1hr', '4hr', 'day', 'week'],
                    description: 'Candle timeframe. 4hr returns 1hr candles (Yahoo Finance limit) — group 4 consecutive 1hr rows as one 4hr period.',
                },
            },
            required: ['ticker', 'timeframe'],
        },
    },
    {
        name: 'get_chart',
        description: 'Render an actual TradingView candlestick chart IMAGE (with indicator overlays) and look at it directly, for VISUAL / structural analysis — chart patterns, trendlines, support/resistance, orderblocks, where price sits relative to moving averages. Renders native 4hr candles (unlike get_candles, which approximates 4hr from 1hr rows). For EXACT numeric levels (precise entry/stop/TP prices) prefer get_candles. ONLY call this once the conversation is about building or refining a concrete trade setup on a SINGLE asset — i.e. you are defining or validating an entry, stop, or take-profit, or confirming the market structure behind that setup. Do NOT call it while scanning / screening for stocks, comparing multiple tickers, or answering general questions about a stock; use get_quote / get_candles / web_search for that. One asset, setup stage only.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: {
                    type: 'string',
                    description: 'Ticker symbol e.g. AAPL, NVDA, BTCUSDT',
                },
                timeframe: {
                    type: 'string',
                    enum: ['1hr', '4hr', 'day', 'week'],
                    description: 'Chart timeframe. Native 4hr is supported here (unlike get_candles).',
                },
                indicators: {
                    type: 'string',
                    description: 'Optional free-text indicators to overlay, e.g. "rsi(14), ema(50), volume". Leave empty for sensible defaults (EMA 20/50).',
                },
                show_to_user: {
                    type: 'boolean',
                    description: 'Set true ONLY when the user would want to SEE this chart in the conversation — they asked to see it, or it directly illustrates the setup you are presenting. Leave false / omit for your own internal visual verification; an internal check must NOT appear in the chat.',
                },
            },
            required: ['ticker', 'timeframe'],
        },
    },
]

// candle count and Yahoo interval per requested timeframe
const _CANDLE_CFG = {
    '1hr':  { timeSpan: 'hour', multiplier: 1, count: 30, windowDays: 5  },
    '4hr':  { timeSpan: 'hour', multiplier: 1, count: 60, windowDays: 12 },  // 1hr rows; LLM groups 4→1
    'day':  { timeSpan: 'day',  multiplier: 1, count: 40, windowDays: 60 },
    'week': { timeSpan: 'week', multiplier: 1, count: 24, windowDays: 200 },
}

function _fmtVol(v) {
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
    if (v >= 1_000)     return (v / 1_000).toFixed(0) + 'K'
    return String(v)
}

const TOOL_HANDLERS = {
    get_quote: async ({ ticker }) => {
        try {
            return await getQuote(ticker)
        } catch (err) {
            logger.warn(LOG, `get_quote failed for ${ticker}:`, err.message)
            return `Could not fetch quote for ${ticker}: ${err.message}`
        }
    },

    get_candles: async ({ ticker, timeframe }) => {
        try {
            const cfg  = _CANDLE_CFG[timeframe] ?? _CANDLE_CFG['day']
            const from = Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000
            const raw  = await getTickerAggregates(ticker.toUpperCase(), { timeSpan: cfg.timeSpan, multiplier: cfg.multiplier, from })
            const rows = raw.slice(-cfg.count)
            if (rows.length === 0) return `No candle data available for ${ticker}`

            const label = timeframe === '4hr' ? '1hr (group 4 rows = one 4hr candle)' : timeframe
            const header = `${ticker.toUpperCase()} ${label} — ${rows.length} candles, newest last:\n`
            const lines  = rows.map(c => {
                const d = new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
                return `${d}  O:${c.open.toFixed(2)}  H:${c.high.toFixed(2)}  L:${c.low.toFixed(2)}  C:${c.close.toFixed(2)}  V:${_fmtVol(c.volume)}`
            })
            return header + lines.join('\n')
        } catch (err) {
            logger.warn(LOG, `get_candles failed for ${ticker}:`, err.message)
            return `Could not fetch candles for ${ticker}: ${err.message}`
        }
    },
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
                return `Could not render chart for ${ticker}: ${err.message}. Use get_candles instead.`
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
        model: MODEL,
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

async function chatStream({ messages, userPrompt, analysisState = emptyAnalysisState(), brokerContext = null, ideaAccounts = [], model: requestedModel, onToken, onAsset, onInterval, onChart }) {
    const systemPrompt   = _buildSystemPrompt(analysisState, brokerContext, ideaAccounts)
    const builtMessages  = _buildMessages({ messages, userPrompt, analysisState })
    const { model, streamFn, provider } = resolveStreamFn(requestedModel)

    // get_chart returns an image tool_result, which only the Anthropic provider
    // renders — gate the tool (and its UI emit) to Anthropic so other providers
    // never receive an image block they can't handle.
    const isAnthropic = provider === 'anthropic'
    const tools        = isAnthropic ? TOOLS : TOOLS.filter(t => t.name !== 'get_chart')
    const toolHandlers = _buildToolHandlers(isAnthropic ? onChart : null)

    logger.info(LOG, 'chatStream start', {
        userPrompt,
        messageCount:  builtMessages.length,
        activeAsset:   analysisState?.structured_state?.active_asset ?? '',
        model,
        provider,
    })

    const raw = await streamFn({
        model,
        promptOrMessages: builtMessages,
        systemPrompt,
        tools,
        toolHandlers,
        onToken,
        onAsset,
        onInterval,
    })

    const { reply, updatedState, tradeIdea } = _parseResponse(raw, analysisState, userPrompt)

    logger.info(LOG, 'chatStream done', {
        replyLength:       reply.length,
        hasTradeIdea:      Boolean(tradeIdea),
        recentMessageCount: updatedState.recent_messages.length,
    })

    return { reply, analysisState: updatedState, ...(tradeIdea ? { tradeIdea } : {}) }
}

function _buildSystemPrompt(analysisState, brokerContext, ideaAccounts = []) {
    const asset   = analysisState?.structured_state?.active_asset || 'none'
    const summary = analysisState?.recent_chat_summary || 'No prior context.'
    const pt      = analysisState?.structured_state?.pending_trade

    // Include the current pending_trade so the LLM updates from it rather than
    // re-deriving the entire state from scratch each turn.
    const stateSection = pt
        ? `\nCurrent pending trade (carry all set fields forward — only update what changed):\n${JSON.stringify(pt, null, 2)}`
        : ''

    // Split into a stable base (the instructions — byte-identical every request)
    // and a volatile context tail. cache_control on the base lets Anthropic cache
    // the tools+instructions prefix across turns (and across users), so only the
    // short tail is reprocessed each request. Returned as system content blocks;
    // the OpenAI provider flattens this array back to a plain string.
    const dynamicContext = `---
CONVERSATION CONTEXT:
${summary}
Active asset: ${asset}${stateSection}${_buildBrokerSection(brokerContext)}${_buildIdeaAccountsSection(ideaAccounts)}`

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
    const fmt = (v) => v != null ? `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'
    const lines = accounts.map(a => {
        const type = a.isLive ? 'LIVE' : 'DEMO'
        const parts = [`${(a.broker || '').toUpperCase()} ${type} — login: ${a.login || '—'}, currency: ${a.currency || '—'}`]
        if (a.balance != null) parts.push(`balance: ${fmt(a.balance)}`)
        if (a.equity  != null) parts.push(`equity: ${fmt(a.equity)}`)
        return `  - ${parts.join(', ')}`
    })
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
        updatedState.recent_messages = _trimMessages(updatedState.recent_messages ?? [])
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
        Array.isArray(state.recent_messages) &&
        typeof state.recent_chat_summary === 'string' &&
        state.structured_state &&
        typeof state.structured_state === 'object'
    )
}

function _fallbackState(priorState, userPrompt, replyText) {
    const prior = priorState && typeof priorState === 'object' ? priorState : emptyAnalysisState()
    const recent_messages = _trimMessages([
        ...(prior.recent_messages ?? []),
        ...(userPrompt?.trim() ? [{ role: 'user', content: userPrompt.trim() }] : []),
        ...(replyText?.trim() ? [{ role: 'assistant', content: replyText.trim() }] : []),
    ])
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
